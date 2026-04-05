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

#ifndef AVUTIL_HWCONTEXT_MEDIACODEC_H
#define AVUTIL_HWCONTEXT_MEDIACODEC_H

/**
 * MediaCodec details.
 *
 * Allocated as AVHWDeviceContext.hwctx
 */
typedef struct AVMediaCodecDeviceContext {
    /**
     * android/view/Surface handle, to be filled by the user.
     *
     * This is the default surface used by decoders on this device.
     */
    void *surface;

    /**
     * Pointer to ANativeWindow.
     *
     * It both surface and native_window is NULL, try to create it
     * automatically if create_window is true and OS support
     * createPersistentInputSurface.
     *
     * It can be used as output surface for decoder and input surface for
     * encoder.
     */
    void *native_window;

    /**
     * Enable createPersistentInputSurface automatically.
     *
     * Disabled by default.
     *
     * It can be enabled by setting this flag directly, or by setting
     * AVDictionary of av_hwdevice_ctx_create(), with "create_window" as key.
     * The second method is useful for ffmpeg cmdline, e.g., we can enable it
     * via:
     *   -init_hw_device mediacodec=mediacodec,create_window=1
     */
    int create_window;
} AVMediaCodecDeviceContext;

#endif /* AVUTIL_HWCONTEXT_MEDIACODEC_H */
