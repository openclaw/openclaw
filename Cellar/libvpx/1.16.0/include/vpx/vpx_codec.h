/*
 *  Copyright (c) 2010 The WebM project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */

/*!\defgroup codec Common Algorithm Interface
 * This abstraction allows applications to easily support multiple video
 * formats with minimal code duplication. This section describes the interface
 * common to all codecs (both encoders and decoders).
 * @{
 */

/*!\file
 * \brief Describes the codec algorithm interface to applications.
 *
 * This file describes the interface between an application and a
 * video codec algorithm.
 *
 * An application instantiates a specific codec instance by using
 * vpx_codec_dec_init() or vpx_codec_enc_init() and a pointer to the
 * algorithm's interface structure:
 *     <pre>
 *     my_app.c:
 *       extern vpx_codec_iface_t my_codec;
 *       {
 *           vpx_codec_ctx_t algo;
 *           int threads = 4;
 *           vpx_codec_dec_cfg_t cfg = { threads, 0, 0 };
 *           res = vpx_codec_dec_init(&algo, &my_codec, &cfg, 0);
 *       }
 *     </pre>
 *
 * Once initialized, the instance is manged using other functions from
 * the vpx_codec_* family.
 */
#ifndef VPX_VPX_VPX_CODEC_H_
#define VPX_VPX_VPX_CODEC_H_

#ifdef __cplusplus
extern "C" {
#endif

#include "./vpx_image.h"
#include "./vpx_integer.h"

/*!\brief Decorator indicating a function is deprecated */
#ifndef VPX_DEPRECATED
#if defined(__GNUC__)
#define VPX_DEPRECATED __attribute__((deprecated))
#elif defined(_MSC_VER)
#define VPX_DEPRECATED
#else
#define VPX_DEPRECATED
#endif
#endif /* VPX_DEPRECATED */

#ifndef VPX_DECLSPEC_DEPRECATED
#if defined(__GNUC__)
#define VPX_DECLSPEC_DEPRECATED /**< \copydoc #VPX_DEPRECATED */
#elif defined(_MSC_VER)
/*!\brief \copydoc #VPX_DEPRECATED */
#define VPX_DECLSPEC_DEPRECATED __declspec(deprecated)
#else
#define VPX_DECLSPEC_DEPRECATED /**< \copydoc #VPX_DEPRECATED */
#endif
#endif /* VPX_DECLSPEC_DEPRECATED */

/*!\brief Decorator indicating a function is potentially unused */
#ifndef VPX_UNUSED
#if defined(__GNUC__) || defined(__clang__)
#define VPX_UNUSED __attribute__((unused))
#else
#define VPX_UNUSED
#endif
#endif /* VPX_UNUSED */

/*!\brief Current ABI version number
 *
 * \internal
 * If this file is altered in any way that changes the ABI, this value
 * must be bumped.  Examples include, but are not limited to, changing
 * types, removing or reassigning enums, adding/removing/rearranging
 * fields to structures
 */
#define VPX_CODEC_ABI_VERSION (4 + VPX_IMAGE_ABI_VERSION) /**<\hideinitializer*/

/*!\brief Algorithm return codes */
typedef enum {
  /*!\brief Operation completed without error */
  VPX_CODEC_OK,

  /*!\brief Unspecified error */
  VPX_CODEC_ERROR,

  /*!\brief Memory operation failed */
  VPX_CODEC_MEM_ERROR,

  /*!\brief ABI version mismatch */
  VPX_CODEC_ABI_MISMATCH,

  /*!\brief Algorithm does not have required capability */
  VPX_CODEC_INCAPABLE,

  /*!\brief The given bitstream is not supported.
   *
   * The bitstream was unable to be parsed at the highest level. The decoder
   * is unable to proceed. This error \ref SHOULD be treated as fatal to the
   * stream. */
  VPX_CODEC_UNSUP_BITSTREAM,

  /*!\brief Encoded bitstream uses an unsupported feature
   *
   * The decoder does not implement a feature required by the encoder. This
   * return code should only be used for features that prevent future
   * pictures from being properly decoded. This error \ref MAY be treated as
   * fatal to the stream or \ref MAY be treated as fatal to the current GOP.
   */
  VPX_CODEC_UNSUP_FEATURE,

  /*!\brief The coded data for this stream is corrupt or incomplete
   *
   * There was a problem decoding the current frame.  This return code
   * should only be used for failures that prevent future pictures from
   * being properly decoded. This error \ref MAY be treated as fatal to the
   * stream or \ref MAY be treated as fatal to the current GOP. If decoding
   * is continued for the current GOP, artifacts may be present.
   */
  VPX_CODEC_CORRUPT_FRAME,

  /*!\brief An application-supplied parameter is not valid.
   *
   */
  VPX_CODEC_INVALID_PARAM,

  /*!\brief An iterator reached the end of list.
   *
   */
  VPX_CODEC_LIST_END

} vpx_codec_err_t;

/*! \brief Codec capabilities bitfield
 *
 *  Each codec advertises the capabilities it supports as part of its
 *  ::vpx_codec_iface_t interface structure. Capabilities are extra interfaces
 *  or functionality, and are not required to be supported.
 *
 *  The available flags are specified by VPX_CODEC_CAP_* defines.
 */
typedef long vpx_codec_caps_t;
#define VPX_CODEC_CAP_DECODER 0x1 /**< Is a decoder */
#define VPX_CODEC_CAP_ENCODER 0x2 /**< Is an encoder */

/*! Can support images at greater than 8 bitdepth.
 */
#define VPX_CODEC_CAP_HIGHBITDEPTH 0x4

/*! \brief Initialization-time Feature Enabling
 *
 *  Certain codec features must be known at initialization time, to allow for
 *  proper memory allocation.
 *
 *  The available flags are specified by VPX_CODEC_USE_* defines.
 */
typedef long vpx_codec_flags_t;

/*!\brief Codec interface structure.
 *
 * Contains function pointers and other data private to the codec
 * implementation. This structure is opaque to the application.
 */
typedef const struct vpx_codec_iface vpx_codec_iface_t;

/*!\brief Codec private data structure.
 *
 * Contains data private to the codec implementation. This structure is opaque
 * to the application.
 */
typedef struct vpx_codec_priv vpx_codec_priv_t;

/*!\brief Iterator
 *
 * Opaque storage used for iterating over lists.
 */
typedef const void *vpx_codec_iter_t;

/*!\brief Codec context structure
 *
 * All codecs \ref MUST support this context structure fully. In general,
 * this data should be considered private to the codec algorithm, and
 * not be manipulated or examined by the calling application. Applications
 * may reference the 'name' member to get a printable description of the
 * algorithm.
 */
typedef struct vpx_codec_ctx {
  const char *name;             /**< Printable interface name */
  vpx_codec_iface_t *iface;     /**< Interface pointers */
  vpx_codec_err_t err;          /**< Last returned error */
  const char *err_detail;       /**< Detailed info, if available */
  vpx_codec_flags_t init_flags; /**< Flags passed at init time */
  union {
    /**< Decoder Configuration Pointer */
    const struct vpx_codec_dec_cfg *dec;
    /**< Encoder Configuration Pointer */
    const struct vpx_codec_enc_cfg *enc;
    const void *raw;
  } config;               /**< Configuration pointer aliasing union */
  vpx_codec_priv_t *priv; /**< Algorithm private storage */
} vpx_codec_ctx_t;

/*!\brief Bit depth for codec
 * *
 * This enumeration determines the bit depth of the codec.
 */
typedef enum vpx_bit_depth {
  VPX_BITS_8 = 8,   /**<  8 bits */
  VPX_BITS_10 = 10, /**< 10 bits */
  VPX_BITS_12 = 12, /**< 12 bits */
} vpx_bit_depth_t;

/*
 * Library Version Number Interface
 *
 * For example, see the following sample return values:
 *     vpx_codec_version()           (1<<16 | 2<<8 | 3)
 *     vpx_codec_version_str()       "v1.2.3-rc1-16-gec6a1ba"
 *     vpx_codec_version_extra_str() "rc1-16-gec6a1ba"
 */

/*!\brief Return the version information (as an integer)
 *
 * Returns a packed encoding of the library version number. This will only
 * include
 * the major.minor.patch component of the version number. Note that this encoded
 * value should be accessed through the macros provided, as the encoding may
 * change
 * in the future.
 *
 */
int vpx_codec_version(void);
#define VPX_VERSION_MAJOR(v) \
  (((v) >> 16) & 0xff) /**< extract major from packed version */
#define VPX_VERSION_MINOR(v) \
  (((v) >> 8) & 0xff) /**< extract minor from packed version */
#define VPX_VERSION_PATCH(v) \
  (((v) >> 0) & 0xff) /**< extract patch from packed version */

/*!\brief Return the version major number */
#define vpx_codec_version_major() ((vpx_codec_version() >> 16) & 0xff)

/*!\brief Return the version minor number */
#define vpx_codec_version_minor() ((vpx_codec_version() >> 8) & 0xff)

/*!\brief Return the version patch number */
#define vpx_codec_version_patch() ((vpx_codec_version() >> 0) & 0xff)

/*!\brief Return the version information (as a string)
 *
 * Returns a printable string containing the full library version number. This
 * may
 * contain additional text following the three digit version number, as to
 * indicate
 * release candidates, prerelease versions, etc.
 *
 */
const char *vpx_codec_version_str(void);

/*!\brief Return the version information (as a string)
 *
 * Returns a printable "extra string". This is the component of the string
 * returned
 * by vpx_codec_version_str() following the three digit version number.
 *
 */
const char *vpx_codec_version_extra_str(void);

/*!\brief Return the build configuration
 *
 * Returns a printable string containing an encoded version of the build
 * configuration. This may be useful to vpx support.
 *
 */
const char *vpx_codec_build_config(void);

/*!\brief Return the name for a given interface
 *
 * Returns a human readable string for name of the given codec interface.
 *
 * \param[in]    iface     Interface pointer
 *
 */
const char *vpx_codec_iface_name(vpx_codec_iface_t *iface);

/*!\brief Convert error number to printable string
 *
 * Returns a human readable string for the last error returned by the
 * algorithm. The returned error will be one line and will not contain
 * any newline characters.
 *
 *
 * \param[in]    err     Error number.
 *
 */
const char *vpx_codec_err_to_string(vpx_codec_err_t err);

/*!\brief Retrieve error synopsis for codec context
 *
 * Returns a human readable string for the last error returned by the
 * algorithm. The returned error will be one line and will not contain
 * any newline characters.
 *
 *
 * \param[in]    ctx     Pointer to this instance's context.
 *
 */
const char *vpx_codec_error(const vpx_codec_ctx_t *ctx);

/*!\brief Retrieve detailed error information for codec context
 *
 * Returns a human readable string providing detailed information about
 * the last error. The returned string is only valid until the next
 * vpx_codec_* function call (except vpx_codec_error and
 * vpx_codec_error_detail) on the codec context.
 *
 * \param[in]    ctx     Pointer to this instance's context.
 *
 * \retval NULL
 *     No detailed information is available.
 */
const char *vpx_codec_error_detail(const vpx_codec_ctx_t *ctx);

/* REQUIRED FUNCTIONS
 *
 * The following functions are required to be implemented for all codecs.
 * They represent the base case functionality expected of all codecs.
 */

/*!\brief Destroy a codec instance
 *
 * Destroys a codec context, freeing any associated memory buffers.
 *
 * \param[in] ctx   Pointer to this instance's context
 *
 * \retval #VPX_CODEC_OK
 *     The codec instance has been destroyed.
 * \retval #VPX_CODEC_INVALID_PARAM
 *     ctx is a null pointer.
 * \retval #VPX_CODEC_ERROR
 *     Codec context not initialized.
 */
vpx_codec_err_t vpx_codec_destroy(vpx_codec_ctx_t *ctx);

/*!\brief Get the capabilities of an algorithm.
 *
 * Retrieves the capabilities bitfield from the algorithm's interface.
 *
 * \param[in] iface   Pointer to the algorithm interface
 *
 */
vpx_codec_caps_t vpx_codec_get_caps(vpx_codec_iface_t *iface);

/*!\brief Control algorithm
 *
 * This function is used to exchange algorithm specific data with the codec
 * instance. This can be used to implement features specific to a particular
 * algorithm.
 *
 * This wrapper function dispatches the request to the helper function
 * associated with the given ctrl_id. It tries to call this function
 * transparently, but will return #VPX_CODEC_ERROR if the request could not
 * be dispatched.
 *
 * Note that this function should not be used directly. Call the
 * #vpx_codec_control wrapper macro instead.
 *
 * \param[in]     ctx              Pointer to this instance's context
 * \param[in]     ctrl_id          Algorithm specific control identifier
 *
 * \retval #VPX_CODEC_OK
 *     The control request was processed.
 * \retval #VPX_CODEC_ERROR
 *     The control request was not processed.
 * \retval #VPX_CODEC_INVALID_PARAM
 *     The data was not valid.
 */
vpx_codec_err_t vpx_codec_control_(vpx_codec_ctx_t *ctx, int ctrl_id, ...);
#if defined(VPX_DISABLE_CTRL_TYPECHECKS) && VPX_DISABLE_CTRL_TYPECHECKS
#define vpx_codec_control(ctx, id, data) vpx_codec_control_(ctx, id, data)
#define VPX_CTRL_USE_TYPE(id, typ)
#define VPX_CTRL_USE_TYPE_DEPRECATED(id, typ)
#define VPX_CTRL_VOID(id, typ)

#else
/*!\brief vpx_codec_control wrapper macro
 *
 * This macro allows for type safe conversions across the variadic parameter
 * to vpx_codec_control_().
 *
 * \internal
 * It works by dispatching the call to the control function through a wrapper
 * function named with the id parameter.
 */
#define vpx_codec_control(ctx, id, data) \
  vpx_codec_control_##id(ctx, id, data) /**<\hideinitializer*/

/*!\brief vpx_codec_control type definition macro
 *
 * This macro allows for type safe conversions across the variadic parameter
 * to vpx_codec_control_(). It defines the type of the argument for a given
 * control identifier.
 *
 * \internal
 * It defines a static function with
 * the correctly typed arguments as a wrapper to the type-unsafe internal
 * function.
 */
#define VPX_CTRL_USE_TYPE(id, typ)                                           \
  static vpx_codec_err_t vpx_codec_control_##id(vpx_codec_ctx_t *, int, typ) \
      VPX_UNUSED;                                                            \
                                                                             \
  static vpx_codec_err_t vpx_codec_control_##id(vpx_codec_ctx_t *ctx,        \
                                                int ctrl_id, typ data) {     \
    return vpx_codec_control_(ctx, ctrl_id, data);                           \
  } /**<\hideinitializer*/

/*!\brief vpx_codec_control deprecated type definition macro
 *
 * Like #VPX_CTRL_USE_TYPE, but indicates that the specified control is
 * deprecated and should not be used. Consult the documentation for your
 * codec for more information.
 *
 * \internal
 * It defines a static function with the correctly typed arguments as a
 * wrapper to the type-unsafe internal function.
 */
#define VPX_CTRL_USE_TYPE_DEPRECATED(id, typ)                            \
  VPX_DECLSPEC_DEPRECATED static vpx_codec_err_t vpx_codec_control_##id( \
      vpx_codec_ctx_t *, int, typ) VPX_DEPRECATED VPX_UNUSED;            \
                                                                         \
  VPX_DECLSPEC_DEPRECATED static vpx_codec_err_t vpx_codec_control_##id( \
      vpx_codec_ctx_t *ctx, int ctrl_id, typ data) {                     \
    return vpx_codec_control_(ctx, ctrl_id, data);                       \
  } /**<\hideinitializer*/

/*!\brief vpx_codec_control void type definition macro
 *
 * This macro allows for type safe conversions across the variadic parameter
 * to vpx_codec_control_(). It indicates that a given control identifier takes
 * no argument.
 *
 * \internal
 * It defines a static function without a data argument as a wrapper to the
 * type-unsafe internal function.
 */
#define VPX_CTRL_VOID(id)                                               \
  static vpx_codec_err_t vpx_codec_control_##id(vpx_codec_ctx_t *, int) \
      VPX_UNUSED;                                                       \
                                                                        \
  static vpx_codec_err_t vpx_codec_control_##id(vpx_codec_ctx_t *ctx,   \
                                                int ctrl_id) {          \
    return vpx_codec_control_(ctx, ctrl_id);                            \
  } /**<\hideinitializer*/

#endif

/*!@} - end defgroup codec*/
#ifdef __cplusplus
}
#endif
#endif  // VPX_VPX_VPX_CODEC_H_
