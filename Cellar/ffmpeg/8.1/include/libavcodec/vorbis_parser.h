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

/**
 * @file
 * A public API for Vorbis parsing
 *
 * Determines the duration for each packet.
 */

#ifndef AVCODEC_VORBIS_PARSER_H
#define AVCODEC_VORBIS_PARSER_H

#include <stdint.h>

typedef struct AVVorbisParseContext AVVorbisParseContext;

/**
 * Allocate and initialize the Vorbis parser using headers in the extradata.
 */
AVVorbisParseContext *av_vorbis_parse_init(const uint8_t *extradata,
                                           int extradata_size);

/**
 * Free the parser and everything associated with it.
 */
void av_vorbis_parse_free(AVVorbisParseContext **s);

#define VORBIS_FLAG_HEADER  0x00000001
#define VORBIS_FLAG_COMMENT 0x00000002
#define VORBIS_FLAG_SETUP   0x00000004

/**
 * Get the duration for a Vorbis packet.
 *
 * If @p flags is @c NULL,
 * special frames are considered invalid.
 *
 * @param s        Vorbis parser context
 * @param buf      buffer containing a Vorbis frame
 * @param buf_size size of the buffer
 * @param flags    flags for special frames
 */
int av_vorbis_parse_frame_flags(AVVorbisParseContext *s, const uint8_t *buf,
                                int buf_size, int *flags);

/**
 * Get the duration for a Vorbis packet.
 *
 * @param s        Vorbis parser context
 * @param buf      buffer containing a Vorbis frame
 * @param buf_size size of the buffer
 */
int av_vorbis_parse_frame(AVVorbisParseContext *s, const uint8_t *buf,
                          int buf_size);

void av_vorbis_parse_reset(AVVorbisParseContext *s);

#endif /* AVCODEC_VORBIS_PARSER_H */
