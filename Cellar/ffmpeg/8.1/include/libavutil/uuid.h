/*
 * Copyright (c) 2022 Pierre-Anthony Lemieux <pal@palemieux.com>
 *                    Zane van Iperen <zane@zanevaniperen.com>
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
 * UUID parsing and serialization utilities.
 * The library treats the UUID as an opaque sequence of 16 unsigned bytes,
 * i.e. ignoring the internal layout of the UUID, which depends on the type
 * of the UUID.
 *
 * @author Pierre-Anthony Lemieux <pal@palemieux.com>
 * @author Zane van Iperen <zane@zanevaniperen.com>
 */

#ifndef AVUTIL_UUID_H
#define AVUTIL_UUID_H

#include <stdint.h>
#include <string.h>

#define AV_PRI_UUID                          \
    "%02hhx%02hhx%02hhx%02hhx-%02hhx%02hhx-" \
    "%02hhx%02hhx-%02hhx%02hhx-%02hhx%02hhx%02hhx%02hhx%02hhx%02hhx"

#define AV_PRI_URN_UUID                               \
    "urn:uuid:%02hhx%02hhx%02hhx%02hhx-%02hhx%02hhx-" \
    "%02hhx%02hhx-%02hhx%02hhx-%02hhx%02hhx%02hhx%02hhx%02hhx%02hhx"

/* AV_UUID_ARG() is used together with AV_PRI_UUID() or AV_PRI_URN_UUID
 * to print UUIDs, e.g.
 * av_log(NULL, AV_LOG_DEBUG, "UUID: " AV_PRI_UUID, AV_UUID_ARG(uuid));
 */
#define AV_UUID_ARG(x)                  \
    (x)[ 0], (x)[ 1], (x)[ 2], (x)[ 3], \
    (x)[ 4], (x)[ 5], (x)[ 6], (x)[ 7], \
    (x)[ 8], (x)[ 9], (x)[10], (x)[11], \
    (x)[12], (x)[13], (x)[14], (x)[15]

#define AV_UUID_LEN 16

/* Binary representation of a UUID */
typedef uint8_t AVUUID[AV_UUID_LEN];

/**
 * Parses a string representation of a UUID formatted according to IETF RFC 4122
 * into an AVUUID. The parsing is case-insensitive. The string must be 37
 * characters long, including the terminating NUL character.
 *
 * Example string representation: "2fceebd0-7017-433d-bafb-d073a7116696"
 *
 * @param[in]  in  String representation of a UUID,
 *                 e.g. 2fceebd0-7017-433d-bafb-d073a7116696
 * @param[out] uu  AVUUID
 * @return         A non-zero value in case of an error.
 */
int av_uuid_parse(const char *in, AVUUID uu);

/**
 * Parses a URN representation of a UUID, as specified at IETF RFC 4122,
 * into an AVUUID. The parsing is case-insensitive. The string must be 46
 * characters long, including the terminating NUL character.
 *
 * Example string representation: "urn:uuid:2fceebd0-7017-433d-bafb-d073a7116696"
 *
 * @param[in]  in  URN UUID
 * @param[out] uu  AVUUID
 * @return         A non-zero value in case of an error.
 */
int av_uuid_urn_parse(const char *in, AVUUID uu);

/**
 * Parses a string representation of a UUID formatted according to IETF RFC 4122
 * into an AVUUID. The parsing is case-insensitive.
 *
 * @param[in]  in_start Pointer to the first character of the string representation
 * @param[in]  in_end   Pointer to the character after the last character of the
 *                      string representation. That memory location is never
 *                      accessed. It is an error if `in_end - in_start != 36`.
 * @param[out] uu       AVUUID
 * @return              A non-zero value in case of an error.
 */
int av_uuid_parse_range(const char *in_start, const char *in_end, AVUUID uu);

/**
 * Serializes a AVUUID into a string representation according to IETF RFC 4122.
 * The string is lowercase and always 37 characters long, including the
 * terminating NUL character.
 *
 * @param[in]  uu  AVUUID
 * @param[out] out Pointer to an array of no less than 37 characters.
 */
void av_uuid_unparse(const AVUUID uu, char *out);

/**
 * Compares two UUIDs for equality.
 *
 * @param[in]  uu1  AVUUID
 * @param[in]  uu2  AVUUID
 * @return          Nonzero if uu1 and uu2 are identical, 0 otherwise
 */
static inline int av_uuid_equal(const AVUUID uu1, const AVUUID uu2)
{
    return memcmp(uu1, uu2, AV_UUID_LEN) == 0;
}

/**
 * Copies the bytes of src into dest.
 *
 * @param[out]  dest  AVUUID
 * @param[in]   src   AVUUID
 */
static inline void av_uuid_copy(AVUUID dest, const AVUUID src)
{
    memcpy(dest, src, AV_UUID_LEN);
}

/**
 * Sets a UUID to the nil UUID, i.e. a UUID with have all
 * its 128 bits set to zero.
 *
 * @param[in,out]  uu  UUID to be set to the nil UUID
 */
static inline void av_uuid_nil(AVUUID uu)
{
    memset(uu, 0, AV_UUID_LEN);
}

#endif /* AVUTIL_UUID_H */
