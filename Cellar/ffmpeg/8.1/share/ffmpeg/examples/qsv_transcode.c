/*
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
 * @file Intel QSV-accelerated video transcoding API usage example
 * @example qsv_transcode.c
 *
 * Perform QSV-accelerated transcoding and show to dynamically change
 * encoder's options.
 *
 * Usage: qsv_transcode input_stream codec output_stream initial option
 *                      { frame_number new_option }
 * e.g: - qsv_transcode input.mp4 h264_qsv output_h264.mp4 "g 60"
 *      - qsv_transcode input.mp4 hevc_qsv output_hevc.mp4 "g 60 async_depth 1"
 *                      100 "g 120"
 *         (initialize codec with gop_size 60 and change it to 120 after 100
 *          frames)
 */

#include <stdio.h>
#include <errno.h>

#include <libavutil/hwcontext.h>
#include <libavutil/mem.h>
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/opt.h>

static AVFormatContext *ifmt_ctx = NULL, *ofmt_ctx = NULL;
static AVBufferRef *hw_device_ctx = NULL;
static AVCodecContext *decoder_ctx = NULL, *encoder_ctx = NULL;
static int video_stream = -1;

typedef struct DynamicSetting {
    int frame_number;
    char* optstr;
} DynamicSetting;
static DynamicSetting *dynamic_setting;
static int setting_number;
static int current_setting_number;

static int str_to_dict(char* optstr, AVDictionary **opt)
{
    char *key, *value;
    if (strlen(optstr) == 0)
        return 0;
    key = strtok(optstr, " ");
    if (key == NULL)
        return AVERROR(EINVAL);
    value = strtok(NULL, " ");
    if (value == NULL)
        return AVERROR(EINVAL);
    av_dict_set(opt, key, value, 0);
    do {
        key = strtok(NULL, " ");
        if (key == NULL)
            return 0;
        value = strtok(NULL, " ");
        if (value == NULL)
            return AVERROR(EINVAL);
        av_dict_set(opt, key, value, 0);
    } while(1);
}

static int dynamic_set_parameter(AVCodecContext *avctx)
{
    AVDictionary *opts = NULL;
    int ret = 0;
    static int frame_number = 0;
    frame_number++;
    if (current_setting_number < setting_number &&
        frame_number == dynamic_setting[current_setting_number].frame_number) {
        AVDictionaryEntry *e = NULL;
        ret = str_to_dict(dynamic_setting[current_setting_number++].optstr, &opts);
        if (ret < 0) {
            fprintf(stderr, "The dynamic parameter is wrong\n");
            goto fail;
        }
        /* Set common option. The dictionary will be freed and replaced
         * by a new one containing all options not found in common option list.
         * Then this new dictionary is used to set private option. */
        if ((ret = av_opt_set_dict(avctx, &opts)) < 0)
            goto fail;
        /* Set codec specific option */
        if ((ret = av_opt_set_dict(avctx->priv_data, &opts)) < 0)
            goto fail;
        /* There is no "framerate" option in common option list. Use "-r" to set
         * framerate, which is compatible with ffmpeg commandline. The video is
         * assumed to be average frame rate, so set time_base to 1/framerate. */
        e = av_dict_get(opts, "r", NULL, 0);
        if (e) {
            avctx->framerate = av_d2q(atof(e->value), INT_MAX);
            encoder_ctx->time_base = av_inv_q(encoder_ctx->framerate);
        }
    }
fail:
    av_dict_free(&opts);
    return ret;
}

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

static int open_input_file(char *filename)
{
    int ret;
    const AVCodec *decoder = NULL;
    AVStream *video = NULL;

    if ((ret = avformat_open_input(&ifmt_ctx, filename, NULL, NULL)) < 0) {
        fprintf(stderr, "Cannot open input file '%s', Error code: %s\n",
                filename, av_err2str(ret));
        return ret;
    }

    if ((ret = avformat_find_stream_info(ifmt_ctx, NULL)) < 0) {
        fprintf(stderr, "Cannot find input stream information. Error code: %s\n",
                av_err2str(ret));
        return ret;
    }

    ret = av_find_best_stream(ifmt_ctx, AVMEDIA_TYPE_VIDEO, -1, -1, NULL, 0);
    if (ret < 0) {
        fprintf(stderr, "Cannot find a video stream in the input file. "
                "Error code: %s\n", av_err2str(ret));
        return ret;
    }
    video_stream = ret;
    video = ifmt_ctx->streams[video_stream];

    switch(video->codecpar->codec_id) {
    case AV_CODEC_ID_H264:
        decoder = avcodec_find_decoder_by_name("h264_qsv");
        break;
    case AV_CODEC_ID_HEVC:
        decoder = avcodec_find_decoder_by_name("hevc_qsv");
        break;
    case AV_CODEC_ID_VP9:
        decoder = avcodec_find_decoder_by_name("vp9_qsv");
        break;
    case AV_CODEC_ID_VP8:
        decoder = avcodec_find_decoder_by_name("vp8_qsv");
        break;
    case AV_CODEC_ID_AV1:
        decoder = avcodec_find_decoder_by_name("av1_qsv");
        break;
    case AV_CODEC_ID_MPEG2VIDEO:
        decoder = avcodec_find_decoder_by_name("mpeg2_qsv");
        break;
    case AV_CODEC_ID_MJPEG:
        decoder = avcodec_find_decoder_by_name("mjpeg_qsv");
        break;
    default:
        fprintf(stderr, "Codec is not supported by qsv\n");
        return AVERROR(EINVAL);
    }

    if (!(decoder_ctx = avcodec_alloc_context3(decoder)))
        return AVERROR(ENOMEM);

    if ((ret = avcodec_parameters_to_context(decoder_ctx, video->codecpar)) < 0) {
        fprintf(stderr, "avcodec_parameters_to_context error. Error code: %s\n",
                av_err2str(ret));
        return ret;
    }
    decoder_ctx->framerate = av_guess_frame_rate(ifmt_ctx, video, NULL);

    decoder_ctx->hw_device_ctx = av_buffer_ref(hw_device_ctx);
    if (!decoder_ctx->hw_device_ctx) {
        fprintf(stderr, "A hardware device reference create failed.\n");
        return AVERROR(ENOMEM);
    }
    decoder_ctx->get_format    = get_format;
    decoder_ctx->pkt_timebase = video->time_base;
    if ((ret = avcodec_open2(decoder_ctx, decoder, NULL)) < 0)
        fprintf(stderr, "Failed to open codec for decoding. Error code: %s\n",
                av_err2str(ret));

    return ret;
}

static int encode_write(AVPacket *enc_pkt, AVFrame *frame)
{
    int ret = 0;

    av_packet_unref(enc_pkt);

    if((ret = dynamic_set_parameter(encoder_ctx)) < 0) {
        fprintf(stderr, "Failed to set dynamic parameter. Error code: %s\n",
                av_err2str(ret));
        goto end;
    }

    if ((ret = avcodec_send_frame(encoder_ctx, frame)) < 0) {
        fprintf(stderr, "Error during encoding. Error code: %s\n", av_err2str(ret));
        goto end;
    }
    while (1) {
        if (ret = avcodec_receive_packet(encoder_ctx, enc_pkt))
            break;
        enc_pkt->stream_index = 0;
        av_packet_rescale_ts(enc_pkt, encoder_ctx->time_base,
                             ofmt_ctx->streams[0]->time_base);
        if ((ret = av_interleaved_write_frame(ofmt_ctx, enc_pkt)) < 0) {
            fprintf(stderr, "Error during writing data to output file. "
                    "Error code: %s\n", av_err2str(ret));
            return ret;
        }
    }

end:
    if (ret == AVERROR_EOF)
        return 0;
    ret = ((ret == AVERROR(EAGAIN)) ? 0:-1);
    return ret;
}

static int dec_enc(AVPacket *pkt, const AVCodec *enc_codec, char *optstr)
{
    AVFrame *frame;
    int ret = 0;

    ret = avcodec_send_packet(decoder_ctx, pkt);
    if (ret < 0) {
        fprintf(stderr, "Error during decoding. Error code: %s\n", av_err2str(ret));
        return ret;
    }

    while (ret >= 0) {
        if (!(frame = av_frame_alloc()))
            return AVERROR(ENOMEM);

        ret = avcodec_receive_frame(decoder_ctx, frame);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            av_frame_free(&frame);
            return 0;
        } else if (ret < 0) {
            fprintf(stderr, "Error while decoding. Error code: %s\n", av_err2str(ret));
            goto fail;
        }
        if (!encoder_ctx->hw_frames_ctx) {
            AVDictionaryEntry *e = NULL;
            AVDictionary *opts = NULL;
            AVStream *ost;
            /* we need to ref hw_frames_ctx of decoder to initialize encoder's codec.
               Only after we get a decoded frame, can we obtain its hw_frames_ctx */
            encoder_ctx->hw_frames_ctx = av_buffer_ref(decoder_ctx->hw_frames_ctx);
            if (!encoder_ctx->hw_frames_ctx) {
                ret = AVERROR(ENOMEM);
                goto fail;
            }
            /* set AVCodecContext Parameters for encoder, here we keep them stay
             * the same as decoder.
             */
            encoder_ctx->time_base = av_inv_q(decoder_ctx->framerate);
            encoder_ctx->pix_fmt   = AV_PIX_FMT_QSV;
            encoder_ctx->width     = decoder_ctx->width;
            encoder_ctx->height    = decoder_ctx->height;
            if ((ret = str_to_dict(optstr, &opts)) < 0) {
                fprintf(stderr, "Failed to set encoding parameter.\n");
                goto fail;
            }
            /* There is no "framerate" option in common option list. Use "-r" to
            * set framerate, which is compatible with ffmpeg commandline. The
            * video is assumed to be average frame rate, so set time_base to
            * 1/framerate. */
            e = av_dict_get(opts, "r", NULL, 0);
            if (e) {
                encoder_ctx->framerate = av_d2q(atof(e->value), INT_MAX);
                encoder_ctx->time_base = av_inv_q(encoder_ctx->framerate);
            }
            if ((ret = avcodec_open2(encoder_ctx, enc_codec, &opts)) < 0) {
                fprintf(stderr, "Failed to open encode codec. Error code: %s\n",
                        av_err2str(ret));
                av_dict_free(&opts);
                goto fail;
            }
            av_dict_free(&opts);

            if (!(ost = avformat_new_stream(ofmt_ctx, enc_codec))) {
                fprintf(stderr, "Failed to allocate stream for output format.\n");
                ret = AVERROR(ENOMEM);
                goto fail;
            }

            ost->time_base = encoder_ctx->time_base;
            ret = avcodec_parameters_from_context(ost->codecpar, encoder_ctx);
            if (ret < 0) {
                fprintf(stderr, "Failed to copy the stream parameters. "
                        "Error code: %s\n", av_err2str(ret));
                goto fail;
            }

            /* write the stream header */
            if ((ret = avformat_write_header(ofmt_ctx, NULL)) < 0) {
                fprintf(stderr, "Error while writing stream header. "
                        "Error code: %s\n", av_err2str(ret));
                goto fail;
            }
        }
        frame->pts = av_rescale_q(frame->pts, decoder_ctx->pkt_timebase,
                                  encoder_ctx->time_base);
        if ((ret = encode_write(pkt, frame)) < 0)
            fprintf(stderr, "Error during encoding and writing.\n");

fail:
        av_frame_free(&frame);
    }
    return ret;
}

int main(int argc, char **argv)
{
    const AVCodec *enc_codec;
    int ret = 0;
    AVPacket *dec_pkt = NULL;

    if (argc < 5 || (argc - 5) % 2) {
        av_log(NULL, AV_LOG_ERROR, "Usage: %s <input file> <encoder> <output file>"
               " <\"encoding option set 0\"> [<frame_number> <\"encoding options set 1\">]...\n", argv[0]);
        return 1;
    }
    setting_number = (argc - 5) / 2;
    dynamic_setting = av_malloc(setting_number * sizeof(*dynamic_setting));
    if (!dynamic_setting) {
        ret = AVERROR(ENOMEM);
        goto end;
    }
    current_setting_number = 0;
    for (int i = 0; i < setting_number; i++) {
        dynamic_setting[i].frame_number = atoi(argv[i*2 + 5]);
        dynamic_setting[i].optstr = argv[i*2 + 6];
    }

    ret = av_hwdevice_ctx_create(&hw_device_ctx, AV_HWDEVICE_TYPE_QSV, NULL, NULL, 0);
    if (ret < 0) {
        fprintf(stderr, "Failed to create a QSV device. Error code: %s\n", av_err2str(ret));
        goto end;
    }

    dec_pkt = av_packet_alloc();
    if (!dec_pkt) {
        fprintf(stderr, "Failed to allocate decode packet\n");
        goto end;
    }

    if ((ret = open_input_file(argv[1])) < 0)
        goto end;

    if (!(enc_codec = avcodec_find_encoder_by_name(argv[2]))) {
        fprintf(stderr, "Could not find encoder '%s'\n", argv[2]);
        ret = -1;
        goto end;
    }

    if ((ret = (avformat_alloc_output_context2(&ofmt_ctx, NULL, NULL, argv[3]))) < 0) {
        fprintf(stderr, "Failed to deduce output format from file extension. Error code: "
                "%s\n", av_err2str(ret));
        goto end;
    }

    if (!(encoder_ctx = avcodec_alloc_context3(enc_codec))) {
        ret = AVERROR(ENOMEM);
        goto end;
    }

    ret = avio_open(&ofmt_ctx->pb, argv[3], AVIO_FLAG_WRITE);
    if (ret < 0) {
        fprintf(stderr, "Cannot open output file. "
                "Error code: %s\n", av_err2str(ret));
        goto end;
    }

    /* read all packets and only transcoding video */
    while (ret >= 0) {
        if ((ret = av_read_frame(ifmt_ctx, dec_pkt)) < 0)
            break;

        if (video_stream == dec_pkt->stream_index)
            ret = dec_enc(dec_pkt, enc_codec, argv[4]);

        av_packet_unref(dec_pkt);
    }

    /* flush decoder */
    av_packet_unref(dec_pkt);
    if ((ret = dec_enc(dec_pkt, enc_codec, argv[4])) < 0) {
        fprintf(stderr, "Failed to flush decoder %s\n", av_err2str(ret));
        goto end;
    }

    /* flush encoder */
    if ((ret = encode_write(dec_pkt, NULL)) < 0) {
        fprintf(stderr, "Failed to flush encoder %s\n", av_err2str(ret));
        goto end;
    }

    /* write the trailer for output stream */
    if ((ret = av_write_trailer(ofmt_ctx)) < 0)
        fprintf(stderr, "Failed to write trailer %s\n", av_err2str(ret));

end:
    avformat_close_input(&ifmt_ctx);
    avformat_close_input(&ofmt_ctx);
    avcodec_free_context(&decoder_ctx);
    avcodec_free_context(&encoder_ctx);
    av_buffer_unref(&hw_device_ctx);
    av_packet_free(&dec_pkt);
    av_freep(&dynamic_setting);
    return ret;
}
