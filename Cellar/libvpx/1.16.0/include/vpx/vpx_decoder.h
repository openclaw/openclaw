/*
 *  Copyright (c) 2010 The WebM project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */
#ifndef VPX_VPX_VPX_DECODER_H_
#define VPX_VPX_VPX_DECODER_H_

/*!\defgroup decoder Decoder Algorithm Interface
 * \ingroup codec
 * This abstraction allows applications using this decoder to easily support
 * multiple video formats with minimal code duplication. This section describes
 * the interface common to all decoders.
 * @{
 */

/*!\file
 * \brief Describes the decoder algorithm interface to applications.
 *
 * This file describes the interface between an application and a
 * video decoder algorithm.
 *
 */
#ifdef __cplusplus
extern "C" {
#endif

#include "./vpx_codec.h"  // IWYU pragma: export
#include "./vpx_frame_buffer.h"

/*!\brief Current ABI version number
 *
 * \internal
 * If this file is altered in any way that changes the ABI, this value
 * must be bumped.  Examples include, but are not limited to, changing
 * types, removing or reassigning enums, adding/removing/rearranging
 * fields to structures
 */
#define VPX_DECODER_ABI_VERSION \
  (3 + VPX_CODEC_ABI_VERSION) /**<\hideinitializer*/

/*! \brief Decoder capabilities bitfield
 *
 *  Each decoder advertises the capabilities it supports as part of its
 *  ::vpx_codec_iface_t interface structure. Capabilities are extra interfaces
 *  or functionality, and are not required to be supported by a decoder.
 *
 *  The available flags are specified by VPX_CODEC_CAP_* defines.
 */
#define VPX_CODEC_CAP_PUT_SLICE 0x10000 /**< Will issue put_slice callbacks */
#define VPX_CODEC_CAP_PUT_FRAME 0x20000 /**< Will issue put_frame callbacks */
#define VPX_CODEC_CAP_POSTPROC 0x40000  /**< Can postprocess decoded frame */
/*!\brief Can conceal errors due to packet loss */
#define VPX_CODEC_CAP_ERROR_CONCEALMENT 0x80000
/*!\brief Can receive encoded frames one fragment at a time */
#define VPX_CODEC_CAP_INPUT_FRAGMENTS 0x100000
/*!\brief Can support frame-based multi-threading */
#define VPX_CODEC_CAP_FRAME_THREADING 0x200000
/*!\brief Can support external frame buffers */
#define VPX_CODEC_CAP_EXTERNAL_FRAME_BUFFER 0x400000

/*! \brief Initialization-time Feature Enabling
 *
 *  Certain codec features must be known at initialization time, to allow for
 *  proper memory allocation.
 *
 *  The available flags are specified by VPX_CODEC_USE_* defines.
 */
#define VPX_CODEC_USE_POSTPROC 0x10000 /**< Postprocess decoded frame */
/*!\brief Conceal errors in decoded frames */
#define VPX_CODEC_USE_ERROR_CONCEALMENT 0x20000
/*!\brief The input frame should be passed to the decoder one fragment at a
 * time */
#define VPX_CODEC_USE_INPUT_FRAGMENTS 0x40000
/*!\brief Enable frame-based multi-threading */
#define VPX_CODEC_USE_FRAME_THREADING 0x80000

/*!\brief Stream properties
 *
 * This structure is used to query or set properties of the decoded
 * stream. Algorithms may extend this structure with data specific
 * to their bitstream by setting the sz member appropriately.
 */
typedef struct vpx_codec_stream_info {
  unsigned int sz;    /**< Size of this structure */
  unsigned int w;     /**< Width (or 0 for unknown/default) */
  unsigned int h;     /**< Height (or 0 for unknown/default) */
  unsigned int is_kf; /**< Current frame is a keyframe */
} vpx_codec_stream_info_t;

/* REQUIRED FUNCTIONS
 *
 * The following functions are required to be implemented for all decoders.
 * They represent the base case functionality expected of all decoders.
 */

/*!\brief Initialization Configurations
 *
 * This structure is used to pass init time configuration options to the
 * decoder.
 */
typedef struct vpx_codec_dec_cfg {
  unsigned int threads; /**< Maximum number of threads to use, default 1 */
  unsigned int w;       /**< Width */
  unsigned int h;       /**< Height */
} vpx_codec_dec_cfg_t;  /**< alias for struct vpx_codec_dec_cfg */

/*!\brief Initialize a decoder instance
 *
 * Initializes a decoder context using the given interface. Applications
 * should call the vpx_codec_dec_init convenience macro instead of this
 * function directly, to ensure that the ABI version number parameter
 * is properly initialized.
 *
 * If the library was configured with --disable-multithread, this call
 * is not thread safe and should be guarded with a lock if being used
 * in a multithreaded context.
 *
 * \param[in]    ctx     Pointer to this instance's context.
 * \param[in]    iface   Pointer to the algorithm interface to use.
 * \param[in]    cfg     Configuration to use, if known. May be NULL.
 * \param[in]    flags   Bitfield of VPX_CODEC_USE_* flags
 * \param[in]    ver     ABI version number. Must be set to
 *                       VPX_DECODER_ABI_VERSION
 * \retval #VPX_CODEC_OK
 *     The decoder algorithm has been initialized.
 * \retval #VPX_CODEC_MEM_ERROR
 *     Memory allocation failed.
 */
vpx_codec_err_t vpx_codec_dec_init_ver(vpx_codec_ctx_t *ctx,
                                       vpx_codec_iface_t *iface,
                                       const vpx_codec_dec_cfg_t *cfg,
                                       vpx_codec_flags_t flags, int ver);

/*!\brief Convenience macro for vpx_codec_dec_init_ver()
 *
 * Ensures the ABI version parameter is properly set.
 */
#define vpx_codec_dec_init(ctx, iface, cfg, flags) \
  vpx_codec_dec_init_ver(ctx, iface, cfg, flags, VPX_DECODER_ABI_VERSION)

/*!\brief Parse stream info from a buffer
 *
 * Performs high level parsing of the bitstream. Construction of a decoder
 * context is not necessary. Can be used to determine if the bitstream is
 * of the proper format, and to extract information from the stream.
 *
 * \param[in]      iface   Pointer to the algorithm interface
 * \param[in]      data    Pointer to a block of data to parse
 * \param[in]      data_sz Size of the data buffer
 * \param[in,out]  si      Pointer to stream info to update. The sz member
 *                         \ref MUST be properly initialized, but \ref MAY be
 *                         clobbered by the algorithm. This parameter \ref MAY
 *                         be NULL.
 *
 * \retval #VPX_CODEC_OK
 *     Bitstream is parsable and stream information updated
 */
vpx_codec_err_t vpx_codec_peek_stream_info(vpx_codec_iface_t *iface,
                                           const uint8_t *data,
                                           unsigned int data_sz,
                                           vpx_codec_stream_info_t *si);

/*!\brief Return information about the current stream.
 *
 * Returns information about the stream that has been parsed during decoding.
 *
 * \param[in]      ctx     Pointer to this instance's context
 * \param[in,out]  si      Pointer to stream info to update. The sz member
 *                         \ref MUST be properly initialized, but \ref MAY be
 *                         clobbered by the algorithm. This parameter \ref MAY
 *                         be NULL.
 *
 * \retval #VPX_CODEC_OK
 *     Bitstream is parsable and stream information updated
 */
vpx_codec_err_t vpx_codec_get_stream_info(vpx_codec_ctx_t *ctx,
                                          vpx_codec_stream_info_t *si);

/*!\brief Decode data
 *
 * Processes a buffer of coded data. If the processing results in a new
 * decoded frame becoming available, put_slice and put_frame callbacks may be
 * invoked, as appropriate. Encoded data \ref MUST be passed in DTS (decode
 * time stamp) order. Frames produced will always be in PTS (presentation
 * time stamp) order.
 * If the decoder is configured with VPX_CODEC_USE_INPUT_FRAGMENTS enabled,
 * data and data_sz can contain a fragment of the encoded frame. Fragment
 * \#n must contain at least partition \#n, but can also contain subsequent
 * partitions (\#n+1 - \#n+i), and if so, fragments \#n+1, .., \#n+i must
 * be empty. When no more data is available, this function should be called
 * with NULL as data and 0 as data_sz. The memory passed to this function
 * must be available until the frame has been decoded.
 *
 * \param[in] ctx          Pointer to this instance's context
 * \param[in] data         Pointer to this block of new coded data. If
 *                         NULL, the put_frame callback is invoked for
 *                         the previously decoded frame.
 * \param[in] data_sz      Size of the coded data, in bytes.
 * \param[in] user_priv    Application specific data to associate with
 *                         this frame.
 * \param[in] deadline     Soft deadline the decoder should attempt to meet,
 *                         in us. Set to zero for unlimited.
 *                         NOTE: The deadline parameter is ignored. Always
 *                         pass 0.
 *
 * \return Returns #VPX_CODEC_OK if the coded data was processed completely
 *         and future pictures can be decoded without error. Otherwise,
 *         see the descriptions of the other error codes in ::vpx_codec_err_t
 *         for recoverability capabilities.
 */
vpx_codec_err_t vpx_codec_decode(vpx_codec_ctx_t *ctx, const uint8_t *data,
                                 unsigned int data_sz, void *user_priv,
                                 long deadline);

/*!\brief Decoded frames iterator
 *
 * Iterates over a list of the frames available for display. The iterator
 * storage should be initialized to NULL to start the iteration. Iteration is
 * complete when this function returns NULL.
 *
 * The list of available frames becomes valid upon completion of the
 * vpx_codec_decode call, and remains valid until the next call to
 * vpx_codec_decode.
 *
 * \param[in]     ctx      Pointer to this instance's context
 * \param[in,out] iter     Iterator storage, initialized to NULL
 *
 * \return Returns a pointer to an image, if one is ready for display. Frames
 *         produced will always be in PTS (presentation time stamp) order.
 */
vpx_image_t *vpx_codec_get_frame(vpx_codec_ctx_t *ctx, vpx_codec_iter_t *iter);

/*!\defgroup cap_put_frame Frame-Based Decoding Functions
 *
 * The following function is required to be implemented for all decoders
 * that advertise the VPX_CODEC_CAP_PUT_FRAME capability. Calling this
 * function for codecs that don't advertise this capability will result in
 * an error code being returned, usually VPX_CODEC_INCAPABLE.
 * @{
 */

/*!\brief put frame callback prototype
 *
 * This callback is invoked by the decoder to notify the application of
 * the availability of decoded image data.
 */
typedef void (*vpx_codec_put_frame_cb_fn_t)(void *user_priv,
                                            const vpx_image_t *img);

/*!\brief Register for notification of frame completion.
 *
 * Registers a given function to be called when a decoded frame is
 * available.
 *
 * \param[in] ctx          Pointer to this instance's context
 * \param[in] cb           Pointer to the callback function
 * \param[in] user_priv    User's private data
 *
 * \retval #VPX_CODEC_OK
 *     Callback successfully registered.
 * \retval #VPX_CODEC_ERROR
 *     Decoder context not initialized.
 * \retval #VPX_CODEC_INCAPABLE
 *     Algorithm not capable of posting frame completion.
 */
vpx_codec_err_t vpx_codec_register_put_frame_cb(vpx_codec_ctx_t *ctx,
                                                vpx_codec_put_frame_cb_fn_t cb,
                                                void *user_priv);

/*!@} - end defgroup cap_put_frame */

/*!\defgroup cap_put_slice Slice-Based Decoding Functions
 *
 * The following function is required to be implemented for all decoders
 * that advertise the VPX_CODEC_CAP_PUT_SLICE capability. Calling this
 * function for codecs that don't advertise this capability will result in
 * an error code being returned, usually VPX_CODEC_INCAPABLE.
 * @{
 */

/*!\brief put slice callback prototype
 *
 * This callback is invoked by the decoder to notify the application of
 * the availability of partially decoded image data.
 */
typedef void (*vpx_codec_put_slice_cb_fn_t)(void *user_priv,
                                            const vpx_image_t *img,
                                            const vpx_image_rect_t *valid,
                                            const vpx_image_rect_t *update);

/*!\brief Register for notification of slice completion.
 *
 * Registers a given function to be called when a decoded slice is
 * available.
 *
 * \param[in] ctx          Pointer to this instance's context
 * \param[in] cb           Pointer to the callback function
 * \param[in] user_priv    User's private data
 *
 * \retval #VPX_CODEC_OK
 *     Callback successfully registered.
 * \retval #VPX_CODEC_ERROR
 *     Decoder context not initialized.
 * \retval #VPX_CODEC_INCAPABLE
 *     Algorithm not capable of posting slice completion.
 */
vpx_codec_err_t vpx_codec_register_put_slice_cb(vpx_codec_ctx_t *ctx,
                                                vpx_codec_put_slice_cb_fn_t cb,
                                                void *user_priv);

/*!@} - end defgroup cap_put_slice*/

/*!\defgroup cap_external_frame_buffer External Frame Buffer Functions
 *
 * The following function is required to be implemented for all decoders
 * that advertise the VPX_CODEC_CAP_EXTERNAL_FRAME_BUFFER capability.
 * Calling this function for codecs that don't advertise this capability
 * will result in an error code being returned, usually VPX_CODEC_INCAPABLE.
 *
 * \note
 * Currently this only works with VP9.
 * @{
 */

/*!\brief Pass in external frame buffers for the decoder to use.
 *
 * Registers functions to be called when libvpx needs a frame buffer
 * to decode the current frame and a function to be called when libvpx does
 * not internally reference the frame buffer. This set function must
 * be called before the first call to decode or libvpx will assume the
 * default behavior of allocating frame buffers internally.
 *
 * \param[in] ctx          Pointer to this instance's context
 * \param[in] cb_get       Pointer to the get callback function
 * \param[in] cb_release   Pointer to the release callback function
 * \param[in] cb_priv      Callback's private data
 *
 * \retval #VPX_CODEC_OK
 *     External frame buffers will be used by libvpx.
 * \retval #VPX_CODEC_INVALID_PARAM
 *     One or more of the callbacks were NULL.
 * \retval #VPX_CODEC_ERROR
 *     Decoder context not initialized.
 * \retval #VPX_CODEC_INCAPABLE
 *     Algorithm not capable of using external frame buffers.
 *
 * \note
 * When decoding VP9, the application may be required to pass in at least
 * #VP9_MAXIMUM_REF_BUFFERS + #VPX_MAXIMUM_WORK_BUFFERS external frame
 * buffers.
 */
vpx_codec_err_t vpx_codec_set_frame_buffer_functions(
    vpx_codec_ctx_t *ctx, vpx_get_frame_buffer_cb_fn_t cb_get,
    vpx_release_frame_buffer_cb_fn_t cb_release, void *cb_priv);

/*!@} - end defgroup cap_external_frame_buffer */

/*!@} - end defgroup decoder*/
#ifdef __cplusplus
}
#endif
#endif  // VPX_VPX_VPX_DECODER_H_
