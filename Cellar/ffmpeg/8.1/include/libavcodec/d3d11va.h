/*
 * Direct3D11 HW acceleration
 *
 * copyright (c) 2009 Laurent Aimar
 * copyright (c) 2015 Steve Lhomme
 *
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

#ifndef AVCODEC_D3D11VA_H
#define AVCODEC_D3D11VA_H

/**
 * @file
 * @ingroup lavc_codec_hwaccel_d3d11va
 * Public libavcodec D3D11VA header.
 */

#if !defined(_WIN32_WINNT) || _WIN32_WINNT < 0x0602
#undef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif

#include <stdint.h>
#include <d3d11.h>

/**
 * @defgroup lavc_codec_hwaccel_d3d11va Direct3D11
 * @ingroup lavc_codec_hwaccel
 *
 * @{
 */

/**
 * This structure is used to provides the necessary configurations and data
 * to the Direct3D11 FFmpeg HWAccel implementation.
 *
 * The application must make it available as AVCodecContext.hwaccel_context.
 *
 * Use av_d3d11va_alloc_context() exclusively to allocate an AVD3D11VAContext.
 */
typedef struct AVD3D11VAContext {
    /**
     * D3D11 decoder object
     */
    ID3D11VideoDecoder *decoder;

    /**
      * D3D11 VideoContext
      */
    ID3D11VideoContext *video_context;

    /**
     * D3D11 configuration used to create the decoder
     */
    D3D11_VIDEO_DECODER_CONFIG *cfg;

    /**
     * The number of surface in the surface array
     */
    unsigned surface_count;

    /**
     * The array of Direct3D surfaces used to create the decoder
     */
    ID3D11VideoDecoderOutputView **surface;

    /**
     * A bit field configuring the workarounds needed for using the decoder
     */
    uint64_t workaround;

    /**
     * Private to the FFmpeg AVHWAccel implementation
     */
    unsigned report_id;

    /**
      * Mutex to access video_context
      */
    HANDLE  context_mutex;
} AVD3D11VAContext;

/**
 * Allocate an AVD3D11VAContext.
 *
 * @return Newly-allocated AVD3D11VAContext or NULL on failure.
 */
AVD3D11VAContext *av_d3d11va_alloc_context(void);

/**
 * @}
 */

#endif /* AVCODEC_D3D11VA_H */
