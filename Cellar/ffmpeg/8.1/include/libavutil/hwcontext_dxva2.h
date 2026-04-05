/*
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


#ifndef AVUTIL_HWCONTEXT_DXVA2_H
#define AVUTIL_HWCONTEXT_DXVA2_H

/**
 * @file
 * An API-specific header for AV_HWDEVICE_TYPE_DXVA2.
 *
 * Only fixed-size pools are supported.
 *
 * For user-allocated pools, AVHWFramesContext.pool must return AVBufferRefs
 * with the data pointer set to a pointer to IDirect3DSurface9.
 */

#include <d3d9.h>
#include <dxva2api.h>

/**
 * This struct is allocated as AVHWDeviceContext.hwctx
 */
typedef struct AVDXVA2DeviceContext {
    IDirect3DDeviceManager9 *devmgr;
} AVDXVA2DeviceContext;

/**
 * This struct is allocated as AVHWFramesContext.hwctx
 */
typedef struct AVDXVA2FramesContext {
    /**
     * The surface type (e.g. DXVA2_VideoProcessorRenderTarget or
     * DXVA2_VideoDecoderRenderTarget). Must be set by the caller.
     */
    DWORD               surface_type;

    /**
     * The surface pool. When an external pool is not provided by the caller,
     * this will be managed (allocated and filled on init, freed on uninit) by
     * libavutil.
     */
    IDirect3DSurface9 **surfaces;
    int              nb_surfaces;

    /**
     * Certain drivers require the decoder to be destroyed before the surfaces.
     * To allow internally managed pools to work properly in such cases, this
     * field is provided.
     *
     * If it is non-NULL, libavutil will call IDirectXVideoDecoder_Release() on
     * it just before the internal surface pool is freed.
     *
     * This is for convenience only. Some code uses other methods to manage the
     * decoder reference.
     */
    IDirectXVideoDecoder *decoder_to_release;
} AVDXVA2FramesContext;

#endif /* AVUTIL_HWCONTEXT_DXVA2_H */
