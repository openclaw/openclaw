/*
* Copyright (c) 2021, Alliance for Open Media. All rights reserved
*
* This source code is subject to the terms of the BSD 2 Clause License and
* the Alliance for Open Media Patent License 1.0. If the BSD 2 Clause License
* was not distributed with this source code in the LICENSE file, you can
* obtain it at https://www.aomedia.org/license/software-license. If the Alliance for Open
* Media Patent License 1.0 was not distributed with this source code in the
* PATENTS file, you can obtain it at https://www.aomedia.org/license/patent-license.
*/

#ifndef EbSvtAv1Metadata_h
#define EbSvtAv1Metadata_h

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

#include <stdio.h>
#include <string.h> //for 'memcpy'
#include "EbSvtAv1.h"
#include "EbSvtAv1Enc.h"

struct EbBufferHeaderType;

typedef enum EbAv1MetadataType {
    EB_AV1_METADATA_TYPE_AOM_RESERVED_0 = 0,
    EB_AV1_METADATA_TYPE_HDR_CLL        = 1,
    EB_AV1_METADATA_TYPE_HDR_MDCV       = 2,
    EB_AV1_METADATA_TYPE_SCALABILITY    = 3,
    EB_AV1_METADATA_TYPE_ITUT_T35       = 4,
    EB_AV1_METADATA_TYPE_TIMECODE       = 5,
    EB_AV1_METADATA_TYPE_FRAME_SIZE     = 6,
} EbAv1MetadataType;

/*!\brief Metadata payload. */
typedef struct SvtMetadata {
    uint32_t type; /**< Metadata type */
    uint8_t* payload; /**< Metadata payload data */
    size_t   sz; /**< Metadata payload size */
} SvtMetadataT;

/*!\brief Array of aom_metadata structs for an image. */
typedef struct SvtMetadataArray {
    size_t         sz; /* Number of metadata structs in the list */
    SvtMetadataT** metadata_array; /* Array of metadata structs */
} SvtMetadataArrayT;

/*!\brief Frame size struct in metadata. */
typedef struct SvtMetadataFrameSize {
    uint16_t width; /**< pixel width of frame */
    uint16_t height; /**< pixel height of frame */
    uint16_t disp_width; /**< display pixel width of frame */
    uint16_t disp_height; /**< display pixel height of frame */
    uint16_t stride; /**< pixel stride of frame */
    uint16_t subsampling_x; /**< subsampling of Cb/Cr in width */
    uint16_t subsampling_y; /**< subsampling of Cb/Cr in height */
} SvtMetadataFrameSizeT;

/*!\brief Allocate memory for SvtMetadataT struct.
 *
 * Allocates storage for the metadata payload, sets its type and copies the
 * payload data into the SvtMetadataT struct. A metadata payload buffer of size
 * sz is allocated and sz bytes are copied from data into the payload buffer.
 *
 * \param[in]    type         Metadata type
 * \param[in]    data         Metadata data pointer
 * \param[in]    sz           Metadata size
 *
 * \return Returns the newly allocated SvtMetadataT struct. If data is NULL,
 * sz is 0, or memory allocation fails, it returns NULL.
 */
EB_API SvtMetadataT* svt_metadata_alloc(const uint32_t type, const uint8_t* data, const size_t sz);

/*!\brief Free metadata struct.
 *
 * Free metadata struct and its buffer.
 *
 * \param[in]    ptr       Metadata struct pointer
 */
EB_API void svt_metadata_free(void* ptr);

/*!\brief Alloc memory for SvtMetadataArrayT struct.
 *
 * Allocate memory for SvtMetadataArrayT struct.
 * If sz is 0 the SvtMetadataArrayT struct's internal buffer list will be
 * NULL, but the SvtMetadataArrayT struct itself will still be allocated.
 * Returns a pointer to the allocated struct or NULL on failure.
 *
 * \param[in]    sz       Size of internal metadata list buffer
 */
EB_API SvtMetadataArrayT* svt_metadata_array_alloc(const size_t sz);

/*!\brief Free metadata array struct.
 *
 * Free metadata array struct and all metadata structs inside.
 *
 * \param[in]    arr       Metadata array struct pointer
 */
EB_API void svt_metadata_array_free(void* arr);

/*!\brief Add metadata to image.
 *
 * Adds metadata to EbBufferHeaderType.
 * Function makes a copy of the provided data parameter.
 * Metadata insertion point is controlled by insert_flag.
 *
 * \param[in]    buffer       Buffer descriptor
 * \param[in]    type         Metadata type
 * \param[in]    data         Metadata contents
 * \param[in]    sz           Metadata contents size
 *
 * \return Returns 0 on success. If buffer or data is NULL, sz is 0, or memory
 * allocation fails, it returns -1.
 */
EB_API int svt_add_metadata(struct EbBufferHeaderType* buffer, const uint32_t type, const uint8_t* data,
                            const size_t sz);

/*!\brief Return metadata size.
 *
 * Returns the metadata size of the selected metadata given by type
 *
 * \param[in]    metadata       Metadata array struct pointer
 * \param[in]    type           Metadata type descriptor
 */
EB_API size_t svt_metadata_size(SvtMetadataArrayT* metadata, const EbAv1MetadataType type);

/*!\brief Parse string into EbSvtAv1MasteringDisplayInfo struct.
 *
 * Splits a string in the format of "G(x,y)B(x,y)R(x,Y)WP(x,y)L(max,min)" into
 * a EbSvtAv1MasteringDisplayInfo struct.
 *
 * \param[in]    mdi           Pointer to EbSvtAv1MasteringDisplayInfo struct
 * \param[in]    md_str       String to parse
 *
 * \return Returns 1 on success. 0 on failure.
 */
EB_API int svt_aom_parse_mastering_display(struct EbSvtAv1MasteringDisplayInfo* mdi, const char* md_str);

/*!\brief Parse string into EbContentLightLevel struct.
 *
 * Splits a string in the format of "max_cll,max_fall" into
 * a EbContentLightLevel struct.
 *
 * \param[in]    cll           Pointer to EbContentLightLevel struct
 * \param[in]    cll_str       String to parse
 *
 * \return Returns 1 on success. 0 on failure.
 */
EB_API int svt_aom_parse_content_light_level(struct EbContentLightLevel* cll, const char* cll_str);

#ifdef __cplusplus
}
#endif // __cplusplus

#endif // EbSvtAv1Metadata_h
