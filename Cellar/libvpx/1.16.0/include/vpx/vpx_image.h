/*
 *  Copyright (c) 2010 The WebM project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree. An additional intellectual property rights grant can be found
 *  in the file PATENTS.  All contributing project authors may
 *  be found in the AUTHORS file in the root of the source tree.
 */

/*!\file
 * \brief Describes the vpx image descriptor and associated operations
 *
 */
#ifndef VPX_VPX_VPX_IMAGE_H_
#define VPX_VPX_VPX_IMAGE_H_

#ifdef __cplusplus
extern "C" {
#endif

/*!\brief Current ABI version number
 *
 * \internal
 * If this file is altered in any way that changes the ABI, this value
 * must be bumped.  Examples include, but are not limited to, changing
 * types, removing or reassigning enums, adding/removing/rearranging
 * fields to structures
 */
#define VPX_IMAGE_ABI_VERSION (5) /**<\hideinitializer*/

#define VPX_IMG_FMT_PLANAR 0x100       /**< Image is a planar format. */
#define VPX_IMG_FMT_UV_FLIP 0x200      /**< V plane precedes U in memory. */
#define VPX_IMG_FMT_HAS_ALPHA 0x400    /**< Image has an alpha channel. */
#define VPX_IMG_FMT_HIGHBITDEPTH 0x800 /**< Image uses 16bit framebuffer. */

/*!\brief List of supported image formats */
typedef enum vpx_img_fmt {
  VPX_IMG_FMT_NONE,
  VPX_IMG_FMT_YV12 =
      VPX_IMG_FMT_PLANAR | VPX_IMG_FMT_UV_FLIP | 1, /**< planar YVU */
  VPX_IMG_FMT_I420 = VPX_IMG_FMT_PLANAR | 2,
  VPX_IMG_FMT_I422 = VPX_IMG_FMT_PLANAR | 5,
  VPX_IMG_FMT_I444 = VPX_IMG_FMT_PLANAR | 6,
  VPX_IMG_FMT_I440 = VPX_IMG_FMT_PLANAR | 7,
  VPX_IMG_FMT_NV12 = VPX_IMG_FMT_PLANAR | 9,
  VPX_IMG_FMT_I42016 = VPX_IMG_FMT_I420 | VPX_IMG_FMT_HIGHBITDEPTH,
  VPX_IMG_FMT_I42216 = VPX_IMG_FMT_I422 | VPX_IMG_FMT_HIGHBITDEPTH,
  VPX_IMG_FMT_I44416 = VPX_IMG_FMT_I444 | VPX_IMG_FMT_HIGHBITDEPTH,
  VPX_IMG_FMT_I44016 = VPX_IMG_FMT_I440 | VPX_IMG_FMT_HIGHBITDEPTH
} vpx_img_fmt_t; /**< alias for enum vpx_img_fmt */

/*!\brief List of supported color spaces */
typedef enum vpx_color_space {
  VPX_CS_UNKNOWN = 0,   /**< Unknown */
  VPX_CS_BT_601 = 1,    /**< BT.601 */
  VPX_CS_BT_709 = 2,    /**< BT.709 */
  VPX_CS_SMPTE_170 = 3, /**< SMPTE.170 */
  VPX_CS_SMPTE_240 = 4, /**< SMPTE.240 */
  VPX_CS_BT_2020 = 5,   /**< BT.2020 */
  VPX_CS_RESERVED = 6,  /**< Reserved */
  VPX_CS_SRGB = 7       /**< sRGB */
} vpx_color_space_t;    /**< alias for enum vpx_color_space */

/*!\brief List of supported color range */
typedef enum vpx_color_range {
  VPX_CR_STUDIO_RANGE = 0, /**<- Y  [16..235],  UV  [16..240]  (bit depth 8) */
                           /**<- Y  [64..940],  UV  [64..960]  (bit depth 10) */
                           /**<- Y [256..3760], UV [256..3840] (bit depth 12) */
  VPX_CR_FULL_RANGE = 1    /**<- YUV/RGB [0..255]  (bit depth 8) */
                           /**<- YUV/RGB [0..1023] (bit depth 10) */
                           /**<- YUV/RGB [0..4095] (bit depth 12) */
} vpx_color_range_t;       /**< alias for enum vpx_color_range */

/**\brief Image Descriptor */
typedef struct vpx_image {
  vpx_img_fmt_t fmt;       /**< Image Format */
  vpx_color_space_t cs;    /**< Color Space */
  vpx_color_range_t range; /**< Color Range */

  /* Image storage dimensions */
  unsigned int w;         /**< Stored image width */
  unsigned int h;         /**< Stored image height */
  unsigned int bit_depth; /**< Stored image bit-depth */

  /* Image display dimensions */
  unsigned int d_w; /**< Displayed image width */
  unsigned int d_h; /**< Displayed image height */

  /* Image intended rendering dimensions */
  unsigned int r_w; /**< Intended rendering image width */
  unsigned int r_h; /**< Intended rendering image height */

  /* Chroma subsampling info */
  unsigned int x_chroma_shift; /**< subsampling order, X */
  unsigned int y_chroma_shift; /**< subsampling order, Y */

/* Image data pointers. */
#define VPX_PLANE_PACKED 0  /**< To be used for all packed formats */
#define VPX_PLANE_Y 0       /**< Y (Luminance) plane */
#define VPX_PLANE_U 1       /**< U (Chroma) plane */
#define VPX_PLANE_V 2       /**< V (Chroma) plane */
#define VPX_PLANE_ALPHA 3   /**< A (Transparency) plane */
  unsigned char *planes[4]; /**< pointer to the top left pixel for each plane */
  int stride[4];            /**< stride between rows for each plane */

  int bps; /**< bits per sample (for packed formats) */

  /*!\brief The following member may be set by the application to associate
   * data with this image.
   */
  void *user_priv;

  /* The following members should be treated as private. */
  unsigned char *img_data; /**< private */
  int img_data_owner;      /**< private */
  int self_allocd;         /**< private */

  void *fb_priv; /**< Frame buffer data associated with the image. */
} vpx_image_t;   /**< alias for struct vpx_image */

/**\brief Representation of a rectangle on a surface */
typedef struct vpx_image_rect {
  unsigned int x;   /**< leftmost column */
  unsigned int y;   /**< topmost row */
  unsigned int w;   /**< width */
  unsigned int h;   /**< height */
} vpx_image_rect_t; /**< alias for struct vpx_image_rect */

/*!\brief Open a descriptor, allocating storage for the underlying image
 *
 * Returns a descriptor for storing an image of the given format. The
 * storage for the image is allocated on the heap.
 *
 * \param[in]    img       Pointer to storage for descriptor. If this parameter
 *                         is NULL, the storage for the descriptor will be
 *                         allocated on the heap.
 * \param[in]    fmt       Format for the image
 * \param[in]    d_w       Width of the image. Must not exceed 0x08000000
 *                         (2^27).
 * \param[in]    d_h       Height of the image. Must not exceed 0x08000000
 *                         (2^27).
 * \param[in]    align     Alignment, in bytes, of the image buffer and
 *                         each row in the image (stride). Must not exceed
 *                         65536.
 *
 * \return Returns a pointer to the initialized image descriptor. If the img
 *         parameter is non-null, the value of the img parameter will be
 *         returned.
 */
vpx_image_t *vpx_img_alloc(vpx_image_t *img, vpx_img_fmt_t fmt,
                           unsigned int d_w, unsigned int d_h,
                           unsigned int align);

/*!\brief Open a descriptor, using existing storage for the underlying image
 *
 * Returns a descriptor for storing an image of the given format. The
 * storage for the image has been allocated elsewhere, and a descriptor is
 * desired to "wrap" that storage.
 *
 * \param[in]    img           Pointer to storage for descriptor. If this
 *                             parameter is NULL, the storage for the descriptor
 *                             will be allocated on the heap.
 * \param[in]    fmt           Format for the image
 * \param[in]    d_w           Width of the image. Must not exceed 0x08000000
 *                             (2^27).
 * \param[in]    d_h           Height of the image. Must not exceed 0x08000000
 *                             (2^27).
 * \param[in]    stride_align  Alignment, in bytes, of each row in the image
 *                             (stride). Must not exceed 65536.
 * \param[in]    img_data      Storage to use for the image. The storage must
 *                             outlive the returned image descriptor; it can be
 *                             disposed of after calling vpx_img_free().
 *
 * \return Returns a pointer to the initialized image descriptor. If the img
 *         parameter is non-null, the value of the img parameter will be
 *         returned.
 *
 * \note \a img_data is required to have a minimum allocation size that
 *       satisfies the requirements of the \a fmt, \a d_w, \a d_h and \a
 *       stride_align parameters. This size can be calculated as follows (see
 *       \c img_alloc_helper in the vpx_image.c file in the libvpx source tree
 *       for more detail):
 * \code
 * align = (1 << x_chroma_shift) - 1;
 * w = (d_w + align) & ~align;
 * align = (1 << y_chroma_shift) - 1;
 * h = (d_h + align) & ~align;
 *
 * s = (fmt & VPX_IMG_FMT_PLANAR) ? w : (uint64_t)bps * w / 8;
 * s = (fmt & VPX_IMG_FMT_HIGHBITDEPTH) ? s * 2 : s;
 * s = (s + stride_align - 1) & ~((uint64_t)stride_align - 1);
 * s = (fmt & VPX_IMG_FMT_HIGHBITDEPTH) ? s / 2 : s;
 * alloc_size = (fmt & VPX_IMG_FMT_PLANAR) ? (uint64_t)h * s * bps / 8
 *                                         : (uint64_t)h * s;
 * \endcode
 * \a x_chroma_shift, \a y_chroma_shift and \a bps can be obtained by calling
 * \ref vpx_img_wrap with a non-\c NULL \a img_data parameter. The \c
 * vpx_image_t pointer should \em not be used in other API calls until \em after
 * a successful call to \ref vpx_img_wrap with a valid image buffer. For
 * example:
 * \code
 * vpx_img_wrap(img, fmt, d_w, d_h, stride_align, (unsigned char *)1);
 * ... calculate buffer size and allocate buffer as described earlier
 * vpx_img_wrap(img, fmt, d_w, d_h, stride_align, img_data);
 * \endcode
 */
vpx_image_t *vpx_img_wrap(vpx_image_t *img, vpx_img_fmt_t fmt, unsigned int d_w,
                          unsigned int d_h, unsigned int stride_align,
                          unsigned char *img_data);

/*!\brief Set the rectangle identifying the displayed portion of the image
 *
 * Updates the displayed rectangle (aka viewport) on the image surface to
 * match the specified coordinates and size. Specifically, sets img->d_w,
 * img->d_h, and elements of the img->planes[] array.
 *
 * \param[in]    img       Image descriptor
 * \param[in]    x         leftmost column
 * \param[in]    y         topmost row
 * \param[in]    w         width
 * \param[in]    h         height
 *
 * \return 0 if the requested rectangle is valid, nonzero (-1) otherwise.
 */
int vpx_img_set_rect(vpx_image_t *img, unsigned int x, unsigned int y,
                     unsigned int w, unsigned int h);

/*!\brief Flip the image vertically (top for bottom)
 *
 * Adjusts the image descriptor's pointers and strides to make the image
 * be referenced upside-down.
 *
 * \param[in]    img       Image descriptor
 */
void vpx_img_flip(vpx_image_t *img);

/*!\brief Close an image descriptor
 *
 * Frees all allocated storage associated with an image descriptor.
 *
 * \param[in]    img       Image descriptor
 */
void vpx_img_free(vpx_image_t *img);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // VPX_VPX_VPX_IMAGE_H_
