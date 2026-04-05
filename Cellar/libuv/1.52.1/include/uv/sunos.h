/* Copyright Joyent, Inc. and other Node contributors. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

#ifndef UV_SUNOS_H
#define UV_SUNOS_H

#include <sys/port.h>
#include <port.h>

/* For the sake of convenience and reduced #ifdef-ery in src/unix/sunos.c,
 * add the fs_event fields even when this version of SunOS doesn't support
 * file watching.
 */
#define UV_PLATFORM_LOOP_FIELDS                                               \
  uv__io_t fs_event_watcher;                                                  \
  int fs_fd;                                                                  \

#if defined(PORT_SOURCE_FILE)

# define UV_PLATFORM_FS_EVENT_FIELDS                                          \
  file_obj_t fo;                                                              \
  int fd;                                                                     \

#endif /* defined(PORT_SOURCE_FILE) */

#endif /* UV_SUNOS_H */
