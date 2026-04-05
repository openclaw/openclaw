/*
 * ngtcp2
 *
 * Copyright (c) 2016 ngtcp2 contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining
 * a copy of this software and associated documentation files (the
 * "Software"), to deal in the Software without restriction, including
 * without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to
 * permit persons to whom the Software is furnished to do so, subject to
 * the following conditions:
 *
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
 * LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
 * OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
#ifndef NGTCP2_VERSION_H
#define NGTCP2_VERSION_H

/**
 * @macrosection
 *
 * Library version macros
 */

/**
 * @macro
 *
 * Version number of the ngtcp2 library release.
 */
#define NGTCP2_VERSION "1.22.0"

/**
 * @macro
 *
 * Numerical representation of the version number of the ngtcp2
 * library release. This is a 24 bit number with 8 bits for major
 * number, 8 bits for minor and 8 bits for patch. Version 1.2.3
 * becomes 0x010203.
 */
#define NGTCP2_VERSION_NUM 0x011600

#endif /* !defined(NGTCP2_VERSION_H) */
