/*
 * Copyright (c) 2015 Anton Khirnov
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */

/**
 * @file Intel QSV-accelerated H.264 decoding API usage example
 * @example qsv_decode.c
 *
 * Perform QSV-accelerated H.264 decoding with output frames in the
 * GPU video surfaces, write the decoded frames to an output file.
 */

#include <stdio.h>

#include <libavformat/avformat.h>
#include <libavformat/avio.h>

#include <libavcodec/avcodec.h>

#include <libavutil/buffer.h>
#include <libavutil/error.h>
#include <libavutil/hwcontext.h>
#include <libavutil/hwcontext_qsv.h>
#include <libavutil/mem.h>

static int get_format(AVCodecContext *avctx, const enum AVPixelFormat *pix_fmts)
{
    while (*pix_fmts != AV_PIX_FMT_NONE) {
        if (*pix_fmts == AV_PIX_FMT_QSV) {
            return AV_PIX_FMT_QSV;
        }

        pix_fmts++;
    }

    fprintf(stderr, "The QSV pixel format not offered in get_format()\n");

    return AV_PIX_FMT_NONE;
}

static int decode_packet(AVCodecContext *decoder_ctx,
                         AVFrame *frame, AVFrame *sw_frame,
                         AVPacket *pkt, AVIOContext *output_ctx)
{
    int ret = 0;

    ret = avcodec_send_packet(decoder_ctx, pkt);
    if (ret < 0) {
        fprintf(stderr, "Error during decoding\n");
        return ret;
    }

    while (ret >= 0) {
        int i, j;

        ret = avcodec_receive_frame(decoder_ctx, frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF)
            break;
        else if (ret < 0) {
            fprintf(stderr, "Error during decoding\n");
            return ret;
        }

        /* A real program would do something useful with the decoded frame here.
         * We just retrieve the raw data and write it to a file, which is rather
         * useless but pedagogic. */
        ret = av_hwframe_transfer_data(sw_frame, frame, 0);
        if (ret < 0) {
            fprintf(stderr, "Error transferring the data to system memory\n");
            goto fail;
        }

        for (i = 0; i < FF_ARRAY_ELEMS(sw_frame->data) && sw_frame->data[i]; i++)
            for (j = 0; j < (sw_frame->height >> (i > 0)); j++)
                avio_write(output_ctx, sw_frame->data[i] + j * sw_frame->linesize[i], sw_frame->width);

fail:
        av_frame_unref(sw_frame);
        av_frame_unref(frame);

        if (ret < 0)
            return ret;
    }

    return 0;
}

int main(int argc, char **argv)
{
    AVFormatContext *input_ctx = NULL;
    AVStream *video_st = NULL;
    AVCodecContext *decoder_ctx = NULL;
    const AVCodec *decoder;

    AVPacket *pkt = NULL;
    AVFrame *frame = NULL, *sw_frame = NULL;

    AVIOContext *output_ctx = NULL;

    int ret, i;

    AVBufferRef *device_ref = NULL;

    if (argc < 3) {
        fprintf(stderr, "Usage: %s <input file> <output file>\n", argv[0]);
        return 1;
    }

    /* open the input file */
    ret = avformat_open_input(&input_ctx, argv[1], NULL, NULL);
    if (ret < 0) {
        fprintf(stderr, "Cannot open input file '%s': ", argv[1]);
        goto finish;
    }

    /* find the first H.264 video stream */
    for (i = 0; i < input_ctx->nb_streams; i++) {
        AVStream *st = input_ctx->streams[i];

        if (st->codecpar->codec_id == AV_CODEC_ID_H264 && !video_st)
            video_st = st;
        else
            st->discard = AVDISCARD_ALL;
    }
    if (!video_st) {
        fprintf(stderr, "No H.264 video stream in the input file\n");
        goto finish;
    }

    /* open the hardware device */
    ret = av_hwdevice_ctx_create(&device_ref, AV_HWDEVICE_TYPE_QSV,
                                 "auto", NULL, 0);
    if (ret < 0) {
        fprintf(stderr, "Cannot open the hardware device\n");
        goto finish;
    }

    /* initialize the decoder */
    decoder = avcodec_find_decoder_by_name("h264_qsv");
    if (!decoder) {
        fprintf(stderr, "The QSV decoder is not present in libavcodec\n");
        goto finish;
    }

    decoder_ctx = avcodec_alloc_context3(decoder);
    if (!decoder_ctx) {
        ret = AVERROR(ENOMEM);
        goto finish;
    }
    decoder_ctx->codec_id = AV_CODEC_ID_H264;
    if (video_st->codecpar->extradata_size) {
        decoder_ctx->extradata = av_mallocz(video_st->codecpar->extradata_size +
                                            AV_INPUT_BUFFER_PADDING_SIZE);
        if (!decoder_ctx->extradata) {
            ret = AVERROR(ENOMEM);
            goto finish;
        }
        memcpy(decoder_ctx->extradata, video_st->codecpar->extradata,
               video_st->codecpar->extradata_size);
        decoder_ctx->extradata_size = video_st->codecpar->extradata_size;
    }


    decoder_ctx->hw_device_ctx = av_buffer_ref(device_ref);
    decoder_ctx->get_format  = get_format;

    ret = avcodec_open2(decoder_ctx, NULL, NULL);
    if (ret < 0) {
        fprintf(stderr, "Error opening the decoder: ");
        goto finish;
    }

    /* open the output stream */
    ret = avio_open(&output_ctx, argv[2], AVIO_FLAG_WRITE);
    if (ret < 0) {
        fprintf(stderr, "Error opening the output context: ");
        goto finish;
    }

    frame    = av_frame_alloc();
    sw_frame = av_frame_alloc();
    pkt      = av_packet_alloc();
    if (!frame || !sw_frame || !pkt) {
        ret = AVERROR(ENOMEM);
        goto finish;
    }

    /* actual decoding */
    while (ret >= 0) {
        ret = av_read_frame(input_ctx, pkt);
        if (ret < 0)
            break;

        if (pkt->stream_index == video_st->index)
            ret = decode_packet(decoder_ctx, frame, sw_frame, pkt, output_ctx);

        av_packet_unref(pkt);
    }

    /* flush the decoder */
    ret = decode_packet(decoder_ctx, frame, sw_frame, NULL, output_ctx);

finish:
    if (ret < 0)
        fprintf(stderr, "%s\n", av_err2str(ret));

    avformat_close_input(&input_ctx);

    av_frame_free(&frame);
    av_frame_free(&sw_frame);
    av_packet_free(&pkt);

    avcodec_free_context(&decoder_ctx);

    av_buffer_unref(&device_ref);

    avio_close(output_ctx);

    return ret;
}
