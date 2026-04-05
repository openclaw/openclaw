/*
 * Version macros.
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

#ifndef AVFILTER_VERSION_MAJOR_H
#define AVFILTER_VERSION_MAJOR_H

/**
 * @file
 * @ingroup lavfi
 * Libavfilter version macros
 */

#define LIBAVFILTER_VERSION_MAJOR  11

/**
 * FF_API_* defines may be placed below to indicate public API that will be
 * dropped at a future version bump. The defines themselves are not part of
 * the public API and may change, break or disappear at any time.
 */

#define FF_API_BUFFERSINK_OPTS (LIBAVFILTER_VERSION_MAJOR < 12)
#define FF_API_CONTEXT_PUBLIC  (LIBAVFILTER_VERSION_MAJOR < 12)
#define FF_API_LIBNPP_SUPPORT  (LIBAVFILTER_VERSION_MAJOR < 12)

#endif /* AVFILTER_VERSION_MAJOR_H */
