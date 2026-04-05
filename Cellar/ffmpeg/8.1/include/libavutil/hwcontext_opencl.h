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

#ifndef AVUTIL_HWCONTEXT_OPENCL_H
#define AVUTIL_HWCONTEXT_OPENCL_H

#ifdef __APPLE__
#include <OpenCL/cl.h>
#else
#include <CL/cl.h>
#endif

#include "frame.h"

/**
 * @file
 * API-specific header for AV_HWDEVICE_TYPE_OPENCL.
 *
 * Pools allocated internally are always dynamic, and are primarily intended
 * to be used in OpenCL-only cases.  If interoperation is required, it is
 * typically required to allocate frames in the other API and then map the
 * frames context to OpenCL with av_hwframe_ctx_create_derived().
 */

/**
 * OpenCL frame descriptor for pool allocation.
 *
 * In user-allocated pools, AVHWFramesContext.pool must return AVBufferRefs
 * with the data pointer pointing at an object of this type describing the
 * planes of the frame.
 */
typedef struct AVOpenCLFrameDescriptor {
    /**
     * Number of planes in the frame.
     */
    int nb_planes;
    /**
     * OpenCL image2d objects for each plane of the frame.
     */
    cl_mem planes[AV_NUM_DATA_POINTERS];
} AVOpenCLFrameDescriptor;

/**
 * OpenCL device details.
 *
 * Allocated as AVHWDeviceContext.hwctx
 */
typedef struct AVOpenCLDeviceContext {
    /**
     * The primary device ID of the device.  If multiple OpenCL devices
     * are associated with the context then this is the one which will
     * be used for all operations internal to FFmpeg.
     */
    cl_device_id device_id;
    /**
     * The OpenCL context which will contain all operations and frames on
     * this device.
     */
    cl_context context;
    /**
     * The default command queue for this device, which will be used by all
     * frames contexts which do not have their own command queue.  If not
     * initialised by the user, a default queue will be created on the
     * primary device.
     */
    cl_command_queue command_queue;
} AVOpenCLDeviceContext;

/**
 * OpenCL-specific data associated with a frame pool.
 *
 * Allocated as AVHWFramesContext.hwctx.
 */
typedef struct AVOpenCLFramesContext {
    /**
     * The command queue used for internal asynchronous operations on this
     * device (av_hwframe_transfer_data(), av_hwframe_map()).
     *
     * If this is not set, the command queue from the associated device is
     * used instead.
     */
    cl_command_queue command_queue;
} AVOpenCLFramesContext;

#endif /* AVUTIL_HWCONTEXT_OPENCL_H */
