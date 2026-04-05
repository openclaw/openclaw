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

#ifndef AVUTIL_HWCONTEXT_H
#define AVUTIL_HWCONTEXT_H

#include "buffer.h"
#include "frame.h"
#include "log.h"
#include "pixfmt.h"

enum AVHWDeviceType {
    AV_HWDEVICE_TYPE_NONE,
    AV_HWDEVICE_TYPE_VDPAU,
    AV_HWDEVICE_TYPE_CUDA,
    AV_HWDEVICE_TYPE_VAAPI,
    AV_HWDEVICE_TYPE_DXVA2,
    AV_HWDEVICE_TYPE_QSV,
    AV_HWDEVICE_TYPE_VIDEOTOOLBOX,
    AV_HWDEVICE_TYPE_D3D11VA,
    AV_HWDEVICE_TYPE_DRM,
    AV_HWDEVICE_TYPE_OPENCL,
    AV_HWDEVICE_TYPE_MEDIACODEC,
    AV_HWDEVICE_TYPE_VULKAN,
    AV_HWDEVICE_TYPE_D3D12VA,
    AV_HWDEVICE_TYPE_AMF,
    /* OpenHarmony Codec device */
    AV_HWDEVICE_TYPE_OHCODEC,
};

/**
 * This struct aggregates all the (hardware/vendor-specific) "high-level" state,
 * i.e. state that is not tied to a concrete processing configuration.
 * E.g., in an API that supports hardware-accelerated encoding and decoding,
 * this struct will (if possible) wrap the state that is common to both encoding
 * and decoding and from which specific instances of encoders or decoders can be
 * derived.
 *
 * This struct is reference-counted with the AVBuffer mechanism. The
 * av_hwdevice_ctx_alloc() constructor yields a reference, whose data field
 * points to the actual AVHWDeviceContext. Further objects derived from
 * AVHWDeviceContext (such as AVHWFramesContext, describing a frame pool with
 * specific properties) will hold an internal reference to it. After all the
 * references are released, the AVHWDeviceContext itself will be freed,
 * optionally invoking a user-specified callback for uninitializing the hardware
 * state.
 */
typedef struct AVHWDeviceContext {
    /**
     * A class for logging. Set by av_hwdevice_ctx_alloc().
     */
    const AVClass *av_class;

    /**
     * This field identifies the underlying API used for hardware access.
     *
     * This field is set when this struct is allocated and never changed
     * afterwards.
     */
    enum AVHWDeviceType type;

    /**
     * The format-specific data, allocated and freed by libavutil along with
     * this context.
     *
     * Should be cast by the user to the format-specific context defined in the
     * corresponding header (hwcontext_*.h) and filled as described in the
     * documentation before calling av_hwdevice_ctx_init().
     *
     * After calling av_hwdevice_ctx_init() this struct should not be modified
     * by the caller.
     */
    void *hwctx;

    /**
     * This field may be set by the caller before calling av_hwdevice_ctx_init().
     *
     * If non-NULL, this callback will be called when the last reference to
     * this context is unreferenced, immediately before it is freed.
     *
     * @note when other objects (e.g an AVHWFramesContext) are derived from this
     *       struct, this callback will be invoked after all such child objects
     *       are fully uninitialized and their respective destructors invoked.
     */
    void (*free)(struct AVHWDeviceContext *ctx);

    /**
     * Arbitrary user data, to be used e.g. by the free() callback.
     */
    void *user_opaque;
} AVHWDeviceContext;

/**
 * This struct describes a set or pool of "hardware" frames (i.e. those with
 * data not located in normal system memory). All the frames in the pool are
 * assumed to be allocated in the same way and interchangeable.
 *
 * This struct is reference-counted with the AVBuffer mechanism and tied to a
 * given AVHWDeviceContext instance. The av_hwframe_ctx_alloc() constructor
 * yields a reference, whose data field points to the actual AVHWFramesContext
 * struct.
 */
typedef struct AVHWFramesContext {
    /**
     * A class for logging.
     */
    const AVClass *av_class;

    /**
     * A reference to the parent AVHWDeviceContext. This reference is owned and
     * managed by the enclosing AVHWFramesContext, but the caller may derive
     * additional references from it.
     */
    AVBufferRef *device_ref;

    /**
     * The parent AVHWDeviceContext. This is simply a pointer to
     * device_ref->data provided for convenience.
     *
     * Set by libavutil in av_hwframe_ctx_init().
     */
    AVHWDeviceContext *device_ctx;

    /**
     * The format-specific data, allocated and freed automatically along with
     * this context.
     *
     * The user shall ignore this field if the corresponding format-specific
     * header (hwcontext_*.h) does not define a context to be used as
     * AVHWFramesContext.hwctx.
     *
     * Otherwise, it should be cast by the user to said context and filled
     * as described in the documentation before calling av_hwframe_ctx_init().
     *
     * After any frames using this context are created, the contents of this
     * struct should not be modified by the caller.
     */
    void *hwctx;

    /**
     * This field may be set by the caller before calling av_hwframe_ctx_init().
     *
     * If non-NULL, this callback will be called when the last reference to
     * this context is unreferenced, immediately before it is freed.
     */
    void (*free)(struct AVHWFramesContext *ctx);

    /**
     * Arbitrary user data, to be used e.g. by the free() callback.
     */
    void *user_opaque;

    /**
     * A pool from which the frames are allocated by av_hwframe_get_buffer().
     * This field may be set by the caller before calling av_hwframe_ctx_init().
     * The buffers returned by calling av_buffer_pool_get() on this pool must
     * have the properties described in the documentation in the corresponding hw
     * type's header (hwcontext_*.h). The pool will be freed strictly before
     * this struct's free() callback is invoked.
     *
     * This field may be NULL, then libavutil will attempt to allocate a pool
     * internally. Note that certain device types enforce pools allocated at
     * fixed size (frame count), which cannot be extended dynamically. In such a
     * case, initial_pool_size must be set appropriately.
     */
    AVBufferPool *pool;

    /**
     * Initial size of the frame pool. If a device type does not support
     * dynamically resizing the pool, then this is also the maximum pool size.
     *
     * May be set by the caller before calling av_hwframe_ctx_init(). Must be
     * set if pool is NULL and the device type does not support dynamic pools.
     */
    int initial_pool_size;

    /**
     * The pixel format identifying the underlying HW surface type.
     *
     * Must be a hwaccel format, i.e. the corresponding descriptor must have the
     * AV_PIX_FMT_FLAG_HWACCEL flag set.
     *
     * Must be set by the user before calling av_hwframe_ctx_init().
     */
    enum AVPixelFormat format;

    /**
     * The pixel format identifying the actual data layout of the hardware
     * frames.
     *
     * Must be set by the caller before calling av_hwframe_ctx_init().
     *
     * @note when the underlying API does not provide the exact data layout, but
     * only the colorspace/bit depth, this field should be set to the fully
     * planar version of that format (e.g. for 8-bit 420 YUV it should be
     * AV_PIX_FMT_YUV420P, not AV_PIX_FMT_NV12 or anything else).
     */
    enum AVPixelFormat sw_format;

    /**
     * The allocated dimensions of the frames in this pool.
     *
     * Must be set by the user before calling av_hwframe_ctx_init().
     */
    int width, height;
} AVHWFramesContext;

/**
 * Look up an AVHWDeviceType by name.
 *
 * @param name String name of the device type (case-insensitive).
 * @return The type from enum AVHWDeviceType, or AV_HWDEVICE_TYPE_NONE if
 *         not found.
 */
enum AVHWDeviceType av_hwdevice_find_type_by_name(const char *name);

/** Get the string name of an AVHWDeviceType.
 *
 * @param type Type from enum AVHWDeviceType.
 * @return Pointer to a static string containing the name, or NULL if the type
 *         is not valid.
 */
const char *av_hwdevice_get_type_name(enum AVHWDeviceType type);

/**
 * Iterate over supported device types.
 *
 * @param prev AV_HWDEVICE_TYPE_NONE initially, then the previous type
 *             returned by this function in subsequent iterations.
 * @return The next usable device type from enum AVHWDeviceType, or
 *         AV_HWDEVICE_TYPE_NONE if there are no more.
 */
enum AVHWDeviceType av_hwdevice_iterate_types(enum AVHWDeviceType prev);

/**
 * Allocate an AVHWDeviceContext for a given hardware type.
 *
 * @param type the type of the hardware device to allocate.
 * @return a reference to the newly created AVHWDeviceContext on success or NULL
 *         on failure.
 */
AVBufferRef *av_hwdevice_ctx_alloc(enum AVHWDeviceType type);

/**
 * Finalize the device context before use. This function must be called after
 * the context is filled with all the required information and before it is
 * used in any way.
 *
 * @param ref a reference to the AVHWDeviceContext
 * @return 0 on success, a negative AVERROR code on failure
 */
int av_hwdevice_ctx_init(AVBufferRef *ref);

/**
 * Open a device of the specified type and create an AVHWDeviceContext for it.
 *
 * This is a convenience function intended to cover the simple cases. Callers
 * who need to fine-tune device creation/management should open the device
 * manually and then wrap it in an AVHWDeviceContext using
 * av_hwdevice_ctx_alloc()/av_hwdevice_ctx_init().
 *
 * The returned context is already initialized and ready for use, the caller
 * should not call av_hwdevice_ctx_init() on it. The user_opaque/free fields of
 * the created AVHWDeviceContext are set by this function and should not be
 * touched by the caller.
 *
 * @param device_ctx On success, a reference to the newly-created device context
 *                   will be written here. The reference is owned by the caller
 *                   and must be released with av_buffer_unref() when no longer
 *                   needed. On failure, NULL will be written to this pointer.
 * @param type The type of the device to create.
 * @param device A type-specific string identifying the device to open.
 * @param opts A dictionary of additional (type-specific) options to use in
 *             opening the device. The dictionary remains owned by the caller.
 * @param flags currently unused
 *
 * @return 0 on success, a negative AVERROR code on failure.
 */
int av_hwdevice_ctx_create(AVBufferRef **device_ctx, enum AVHWDeviceType type,
                           const char *device, AVDictionary *opts, int flags);

/**
 * Create a new device of the specified type from an existing device.
 *
 * If the source device is a device of the target type or was originally
 * derived from such a device (possibly through one or more intermediate
 * devices of other types), then this will return a reference to the
 * existing device of the same type as is requested.
 *
 * Otherwise, it will attempt to derive a new device from the given source
 * device.  If direct derivation to the new type is not implemented, it will
 * attempt the same derivation from each ancestor of the source device in
 * turn looking for an implemented derivation method.
 *
 * @param dst_ctx On success, a reference to the newly-created
 *                AVHWDeviceContext.
 * @param type    The type of the new device to create.
 * @param src_ctx A reference to an existing AVHWDeviceContext which will be
 *                used to create the new device.
 * @param flags   Currently unused; should be set to zero.
 * @return        Zero on success, a negative AVERROR code on failure.
 */
int av_hwdevice_ctx_create_derived(AVBufferRef **dst_ctx,
                                   enum AVHWDeviceType type,
                                   AVBufferRef *src_ctx, int flags);

/**
 * Create a new device of the specified type from an existing device.
 *
 * This function performs the same action as av_hwdevice_ctx_create_derived,
 * however, it is able to set options for the new device to be derived.
 *
 * @param dst_ctx On success, a reference to the newly-created
 *                AVHWDeviceContext.
 * @param type    The type of the new device to create.
 * @param src_ctx A reference to an existing AVHWDeviceContext which will be
 *                used to create the new device.
 * @param options Options for the new device to create, same format as in
 *                av_hwdevice_ctx_create.
 * @param flags   Currently unused; should be set to zero.
 * @return        Zero on success, a negative AVERROR code on failure.
 */
int av_hwdevice_ctx_create_derived_opts(AVBufferRef **dst_ctx,
                                        enum AVHWDeviceType type,
                                        AVBufferRef *src_ctx,
                                        AVDictionary *options, int flags);

/**
 * Allocate an AVHWFramesContext tied to a given device context.
 *
 * @param device_ctx a reference to a AVHWDeviceContext. This function will make
 *                   a new reference for internal use, the one passed to the
 *                   function remains owned by the caller.
 * @return a reference to the newly created AVHWFramesContext on success or NULL
 *         on failure.
 */
AVBufferRef *av_hwframe_ctx_alloc(AVBufferRef *device_ctx);

/**
 * Finalize the context before use. This function must be called after the
 * context is filled with all the required information and before it is attached
 * to any frames.
 *
 * @param ref a reference to the AVHWFramesContext
 * @return 0 on success, a negative AVERROR code on failure
 */
int av_hwframe_ctx_init(AVBufferRef *ref);

/**
 * Allocate a new frame attached to the given AVHWFramesContext.
 *
 * @param hwframe_ctx a reference to an AVHWFramesContext
 * @param frame an empty (freshly allocated or unreffed) frame to be filled with
 *              newly allocated buffers.
 * @param flags currently unused, should be set to zero
 * @return 0 on success, a negative AVERROR code on failure
 */
int av_hwframe_get_buffer(AVBufferRef *hwframe_ctx, AVFrame *frame, int flags);

/**
 * Copy data to or from a hw surface. At least one of dst/src must have an
 * AVHWFramesContext attached.
 *
 * If src has an AVHWFramesContext attached, then the format of dst (if set)
 * must use one of the formats returned by av_hwframe_transfer_get_formats(src,
 * AV_HWFRAME_TRANSFER_DIRECTION_FROM).
 * If dst has an AVHWFramesContext attached, then the format of src must use one
 * of the formats returned by av_hwframe_transfer_get_formats(dst,
 * AV_HWFRAME_TRANSFER_DIRECTION_TO)
 *
 * dst may be "clean" (i.e. with data/buf pointers unset), in which case the
 * data buffers will be allocated by this function using av_frame_get_buffer().
 * If dst->format is set, then this format will be used, otherwise (when
 * dst->format is AV_PIX_FMT_NONE) the first acceptable format will be chosen.
 *
 * The two frames must have matching allocated dimensions (i.e. equal to
 * AVHWFramesContext.width/height), since not all device types support
 * transferring a sub-rectangle of the whole surface. The display dimensions
 * (i.e. AVFrame.width/height) may be smaller than the allocated dimensions, but
 * also have to be equal for both frames. When the display dimensions are
 * smaller than the allocated dimensions, the content of the padding in the
 * destination frame is unspecified.
 *
 * @param dst the destination frame. dst is not touched on failure.
 * @param src the source frame.
 * @param flags currently unused, should be set to zero
 * @return 0 on success, a negative AVERROR error code on failure.
 */
int av_hwframe_transfer_data(AVFrame *dst, const AVFrame *src, int flags);

enum AVHWFrameTransferDirection {
    /**
     * Transfer the data from the queried hw frame.
     */
    AV_HWFRAME_TRANSFER_DIRECTION_FROM,

    /**
     * Transfer the data to the queried hw frame.
     */
    AV_HWFRAME_TRANSFER_DIRECTION_TO,
};

/**
 * Get a list of possible source or target formats usable in
 * av_hwframe_transfer_data().
 *
 * @param hwframe_ctx the frame context to obtain the information for
 * @param dir the direction of the transfer
 * @param formats the pointer to the output format list will be written here.
 *                The list is terminated with AV_PIX_FMT_NONE and must be freed
 *                by the caller when no longer needed using av_free().
 *                If this function returns successfully, the format list will
 *                have at least one item (not counting the terminator).
 *                On failure, the contents of this pointer are unspecified.
 * @param flags currently unused, should be set to zero
 * @return 0 on success, a negative AVERROR code on failure.
 */
int av_hwframe_transfer_get_formats(AVBufferRef *hwframe_ctx,
                                    enum AVHWFrameTransferDirection dir,
                                    enum AVPixelFormat **formats, int flags);


/**
 * This struct describes the constraints on hardware frames attached to
 * a given device with a hardware-specific configuration.  This is returned
 * by av_hwdevice_get_hwframe_constraints() and must be freed by
 * av_hwframe_constraints_free() after use.
 */
typedef struct AVHWFramesConstraints {
    /**
     * A list of possible values for format in the hw_frames_ctx,
     * terminated by AV_PIX_FMT_NONE.  This member will always be filled.
     */
    enum AVPixelFormat *valid_hw_formats;

    /**
     * A list of possible values for sw_format in the hw_frames_ctx,
     * terminated by AV_PIX_FMT_NONE.  Can be NULL if this information is
     * not known.
     */
    enum AVPixelFormat *valid_sw_formats;

    /**
     * The minimum size of frames in this hw_frames_ctx.
     * (Zero if not known.)
     */
    int min_width;
    int min_height;

    /**
     * The maximum size of frames in this hw_frames_ctx.
     * (INT_MAX if not known / no limit.)
     */
    int max_width;
    int max_height;
} AVHWFramesConstraints;

/**
 * Allocate a HW-specific configuration structure for a given HW device.
 * After use, the user must free all members as required by the specific
 * hardware structure being used, then free the structure itself with
 * av_free().
 *
 * @param device_ctx a reference to the associated AVHWDeviceContext.
 * @return The newly created HW-specific configuration structure on
 *         success or NULL on failure.
 */
void *av_hwdevice_hwconfig_alloc(AVBufferRef *device_ctx);

/**
 * Get the constraints on HW frames given a device and the HW-specific
 * configuration to be used with that device.  If no HW-specific
 * configuration is provided, returns the maximum possible capabilities
 * of the device.
 *
 * @param ref a reference to the associated AVHWDeviceContext.
 * @param hwconfig a filled HW-specific configuration structure, or NULL
 *        to return the maximum possible capabilities of the device.
 * @return AVHWFramesConstraints structure describing the constraints
 *         on the device, or NULL if not available.
 */
AVHWFramesConstraints *av_hwdevice_get_hwframe_constraints(AVBufferRef *ref,
                                                           const void *hwconfig);

/**
 * Free an AVHWFrameConstraints structure.
 *
 * @param constraints The (filled or unfilled) AVHWFrameConstraints structure.
 */
void av_hwframe_constraints_free(AVHWFramesConstraints **constraints);


/**
 * Flags to apply to frame mappings.
 */
enum {
    /**
     * The mapping must be readable.
     */
    AV_HWFRAME_MAP_READ      = 1 << 0,
    /**
     * The mapping must be writeable.
     */
    AV_HWFRAME_MAP_WRITE     = 1 << 1,
    /**
     * The mapped frame will be overwritten completely in subsequent
     * operations, so the current frame data need not be loaded.  Any values
     * which are not overwritten are unspecified.
     */
    AV_HWFRAME_MAP_OVERWRITE = 1 << 2,
    /**
     * The mapping must be direct.  That is, there must not be any copying in
     * the map or unmap steps.  Note that performance of direct mappings may
     * be much lower than normal memory.
     */
    AV_HWFRAME_MAP_DIRECT    = 1 << 3,
};

/**
 * Map a hardware frame.
 *
 * This has a number of different possible effects, depending on the format
 * and origin of the src and dst frames.  On input, src should be a usable
 * frame with valid buffers and dst should be blank (typically as just created
 * by av_frame_alloc()).  src should have an associated hwframe context, and
 * dst may optionally have a format and associated hwframe context.
 *
 * If src was created by mapping a frame from the hwframe context of dst,
 * then this function undoes the mapping - dst is replaced by a reference to
 * the frame that src was originally mapped from.
 *
 * If both src and dst have an associated hwframe context, then this function
 * attempts to map the src frame from its hardware context to that of dst and
 * then fill dst with appropriate data to be usable there.  This will only be
 * possible if the hwframe contexts and associated devices are compatible -
 * given compatible devices, av_hwframe_ctx_create_derived() can be used to
 * create a hwframe context for dst in which mapping should be possible.
 *
 * If src has a hwframe context but dst does not, then the src frame is
 * mapped to normal memory and should thereafter be usable as a normal frame.
 * If the format is set on dst, then the mapping will attempt to create dst
 * with that format and fail if it is not possible.  If format is unset (is
 * AV_PIX_FMT_NONE) then dst will be mapped with whatever the most appropriate
 * format to use is (probably the sw_format of the src hwframe context).
 *
 * A return value of AVERROR(ENOSYS) indicates that the mapping is not
 * possible with the given arguments and hwframe setup, while other return
 * values indicate that it failed somehow.
 *
 * On failure, the destination frame will be left blank, except for the
 * hw_frames_ctx/format fields they may have been set by the caller - those will
 * be preserved as they were.
 *
 * @param dst Destination frame, to contain the mapping.
 * @param src Source frame, to be mapped.
 * @param flags Some combination of AV_HWFRAME_MAP_* flags.
 * @return Zero on success, negative AVERROR code on failure.
 */
int av_hwframe_map(AVFrame *dst, const AVFrame *src, int flags);


/**
 * Create and initialise an AVHWFramesContext as a mapping of another existing
 * AVHWFramesContext on a different device.
 *
 * av_hwframe_ctx_init() should not be called after this.
 *
 * @param derived_frame_ctx  On success, a reference to the newly created
 *                           AVHWFramesContext.
 * @param format             The AVPixelFormat for the derived context.
 * @param derived_device_ctx A reference to the device to create the new
 *                           AVHWFramesContext on.
 * @param source_frame_ctx   A reference to an existing AVHWFramesContext
 *                           which will be mapped to the derived context.
 * @param flags  Some combination of AV_HWFRAME_MAP_* flags, defining the
 *               mapping parameters to apply to frames which are allocated
 *               in the derived device.
 * @return       Zero on success, negative AVERROR code on failure.
 */
int av_hwframe_ctx_create_derived(AVBufferRef **derived_frame_ctx,
                                  enum AVPixelFormat format,
                                  AVBufferRef *derived_device_ctx,
                                  AVBufferRef *source_frame_ctx,
                                  int flags);

#endif /* AVUTIL_HWCONTEXT_H */
