/*
 * EXIF metadata parser
 * Copyright (c) 2013 Thilo Borgmann <thilo.borgmann _at_ mail.de>
 * Copyright (c) 2024-2025 Leo Izen <leo.izen@gmail.com>
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

/**
 * @file
 * EXIF metadata parser
 * @author Thilo Borgmann <thilo.borgmann _at_ mail.de>
 * @author Leo Izen <leo.izen@gmail.com>
 */

#ifndef AVCODEC_EXIF_H
#define AVCODEC_EXIF_H

#include <stddef.h>
#include <stdint.h>

#include "libavutil/buffer.h"
#include "libavutil/dict.h"
#include "libavutil/rational.h"
#include "version_major.h"

/** Data type identifiers for TIFF tags */
enum AVTiffDataType {
    AV_TIFF_BYTE = 1,
    AV_TIFF_STRING,
    AV_TIFF_SHORT,
    AV_TIFF_LONG,
    AV_TIFF_RATIONAL,
    AV_TIFF_SBYTE,
    AV_TIFF_UNDEFINED,
    AV_TIFF_SSHORT,
    AV_TIFF_SLONG,
    AV_TIFF_SRATIONAL,
    AV_TIFF_FLOAT,
    AV_TIFF_DOUBLE,
    AV_TIFF_IFD,
};

enum AVExifHeaderMode {
    /**
     * The TIFF header starts with 0x49492a00, or 0x4d4d002a.
     * This one is used internally by FFmpeg.
     */
    AV_EXIF_TIFF_HEADER,
    /** skip the TIFF header, assume little endian */
    AV_EXIF_ASSUME_LE,
    /** skip the TIFF header, assume big endian */
    AV_EXIF_ASSUME_BE,
    /** The first four bytes point to the actual start, then it's AV_EXIF_TIFF_HEADER */
    AV_EXIF_T_OFF,
    /** The first six bytes contain "Exif\0\0", then it's AV_EXIF_TIFF_HEADER */
    AV_EXIF_EXIF00,
};

typedef struct AVExifEntry AVExifEntry;

typedef struct AVExifMetadata {
    /* array of EXIF metadata entries */
    AVExifEntry *entries;
    /* number of entries in this array */
    unsigned int count;
    /* size of the buffer, used for av_fast_realloc */
    unsigned int size;
} AVExifMetadata;

struct AVExifEntry {
    uint16_t id;
    enum AVTiffDataType type;
    uint32_t count;

    /*
     * These are for IFD-style MakerNote
     * entries which occur after a fixed
     * offset rather than at the start of
     * the entry. The ifd_lead field contains
     * the leading bytes which typically
     * identify the type of MakerNote.
     */
    uint32_t ifd_offset;
    uint8_t *ifd_lead;

    /*
     * An array of entries of size count
     * Unless it's an IFD, in which case
     * it's not an array and count = 1
     */
    union {
        void *ptr;
        int64_t *sint;
        uint64_t *uint;
        double *dbl;
        char *str;
        uint8_t *ubytes;
        int8_t *sbytes;
        AVRational *rat;
        AVExifMetadata ifd;
    } value;
};

/**
 * Retrieves the tag name associated with the provided tag ID.
 * If the tag ID is unknown, NULL is returned.
 *
 * For example, av_exif_get_tag_name(0x112) returns "Orientation".
 */
const char *av_exif_get_tag_name(uint16_t id);

/**
 * Retrieves the tag ID associated with the provided tag string name.
 * If the tag name is unknown, a negative number is returned. Otherwise
 * it always fits inside a uint16_t integer.
 *
 * For example, av_exif_get_tag_id("Orientation") returns 274 (0x0112).
 */
int32_t av_exif_get_tag_id(const char *name);

/**
  * Add an entry to the provided EXIF metadata struct. If one already exists with the provided
  * ID, it will set the existing one to have the other information provided. Otherwise, it
  * will allocate a new entry.
  *
  * This function reallocates ifd->entries using av_realloc and allocates (using av_malloc)
  * a new value member of the entry, then copies the contents of value into that buffer.
 */
int av_exif_set_entry(void *logctx, AVExifMetadata *ifd, uint16_t id, enum AVTiffDataType type,
                      uint32_t count, const uint8_t *ifd_lead, uint32_t ifd_offset, const void *value);

/**
 * Also check subdirectories.
 */
#define AV_EXIF_FLAG_RECURSIVE (1 << 0)

/**
 * Get an entry with the tagged ID from the EXIF metadata struct. A pointer to the entry
 * will be written into *value.
 *
 * If the entry was present and returned successfully, a positive number is returned.
 * If the entry was not found, *value is left untouched and zero is returned.
 * If an error occurred, a negative number is returned.
 */
int av_exif_get_entry(void *logctx, AVExifMetadata *ifd, uint16_t id, int flags, AVExifEntry **value);

/**
 * Remove an entry from the provided EXIF metadata struct.
 *
 * If the entry was present and removed successfully, a positive number is returned.
 * If the entry was not found, zero is returned.
 * If an error occurred, a negative number is returned.
 */
int av_exif_remove_entry(void *logctx, AVExifMetadata *ifd, uint16_t id, int flags);

/**
 * Decodes the EXIF data provided in the buffer and writes it into the
 * struct *ifd. If this function succeeds, the IFD is owned by the caller
 * and must be cleared after use by calling av_exif_free(); If this function
 * fails and returns a negative value, it will call av_exif_free(ifd) before
 * returning.
 */
int av_exif_parse_buffer(void *logctx, const uint8_t *data, size_t size,
                         AVExifMetadata *ifd, enum AVExifHeaderMode header_mode);

/**
 * Allocates a buffer using av_malloc of an appropriate size and writes the
 * EXIF data represented by ifd into that buffer.
 *
 * Upon error, *buffer will be NULL. The buffer becomes owned by the caller upon
 * success. The *buffer argument must be NULL before calling.
 */
int av_exif_write(void *logctx, const AVExifMetadata *ifd, AVBufferRef **buffer, enum AVExifHeaderMode header_mode);

/**
 * Frees all resources associated with the given EXIF metadata struct.
 * Does not free the pointer passed itself, in case it is stack-allocated.
 * The pointer passed to this function must be freed by the caller,
 * if it is heap-allocated. Passing NULL is permitted.
 */
void av_exif_free(AVExifMetadata *ifd);

/**
 * Recursively reads all tags from the IFD and stores them in the
 * provided metadata dictionary.
 */
int av_exif_ifd_to_dict(void *logctx, const AVExifMetadata *ifd, AVDictionary **metadata);

/**
 * Allocates a duplicate of the provided EXIF metadata struct. The caller owns
 * the duplicate and must free it with av_exif_free. Returns NULL if the duplication
 * process failed.
 */
AVExifMetadata *av_exif_clone_ifd(const AVExifMetadata *ifd);

/**
 * Convert a display matrix used by AV_FRAME_DATA_DISPLAYMATRIX
 * into an orientation constant used by EXIF's orientation tag.
 *
 * Returns an EXIF orientation between 1 and 8 (inclusive) depending
 * on the rotation and flip factors. Returns 0 if the matrix is singular.
 */
int av_exif_matrix_to_orientation(const int32_t *matrix);

/**
 * Convert an orientation constant used by EXIF's orientation tag
 * into a display matrix used by AV_FRAME_DATA_DISPLAYMATRIX.
 *
 * Returns 0 on success and negative if the orientation is invalid,
 * i.e. not between 1 and 8 (inclusive).
 */
int av_exif_orientation_to_matrix(int32_t *matrix, int orientation);

#endif /* AVCODEC_EXIF_H */
