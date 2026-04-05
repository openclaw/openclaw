/* MIT License
 *
 * Copyright (c) Massachusetts Institute of Technology
 * Copyright (c) The c-ares project and its contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice (including the next
 * paragraph) shall be included in all copies or substantial portions of the
 * Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * SPDX-License-Identifier: MIT
 */
#ifndef HEADER_CARES_DNS_H
#define HEADER_CARES_DNS_H

/*
 * NOTE TO INTEGRATORS:
 *
 * This header is made public due to legacy projects relying on it.
 * Please do not use the macros within this header, or include this
 * header in your project as it may be removed in the future.
 */


/*
 * Macro DNS__16BIT reads a network short (16 bit) given in network
 * byte order, and returns its value as an unsigned short.
 */
#define DNS__16BIT(p)                                                \
  ((unsigned short)((unsigned int)0xffff &                           \
                    (((unsigned int)((unsigned char)(p)[0]) << 8U) | \
                     ((unsigned int)((unsigned char)(p)[1])))))

/*
 * Macro DNS__32BIT reads a network long (32 bit) given in network
 * byte order, and returns its value as an unsigned int.
 */
#define DNS__32BIT(p)                                              \
  ((unsigned int)(((unsigned int)((unsigned char)(p)[0]) << 24U) | \
                  ((unsigned int)((unsigned char)(p)[1]) << 16U) | \
                  ((unsigned int)((unsigned char)(p)[2]) << 8U) |  \
                  ((unsigned int)((unsigned char)(p)[3]))))

#define DNS__SET16BIT(p, v)                       \
  (((p)[0] = (unsigned char)(((v) >> 8) & 0xff)), \
   ((p)[1] = (unsigned char)((v) & 0xff)))
#define DNS__SET32BIT(p, v)                        \
  (((p)[0] = (unsigned char)(((v) >> 24) & 0xff)), \
   ((p)[1] = (unsigned char)(((v) >> 16) & 0xff)), \
   ((p)[2] = (unsigned char)(((v) >> 8) & 0xff)),  \
   ((p)[3] = (unsigned char)((v) & 0xff)))

#if 0
/* we cannot use this approach on systems where we can't access 16/32 bit
   data on un-aligned addresses */
#  define DNS__16BIT(p)       ntohs(*(unsigned short *)(p))
#  define DNS__32BIT(p)       ntohl(*(unsigned long *)(p))
#  define DNS__SET16BIT(p, v) *(unsigned short *)(p) = htons(v)
#  define DNS__SET32BIT(p, v) *(unsigned long *)(p) = htonl(v)
#endif

/* Macros for parsing a DNS header */
#define DNS_HEADER_QID(h)     DNS__16BIT(h)
#define DNS_HEADER_QR(h)      (((h)[2] >> 7) & 0x1)
#define DNS_HEADER_OPCODE(h)  (((h)[2] >> 3) & 0xf)
#define DNS_HEADER_AA(h)      (((h)[2] >> 2) & 0x1)
#define DNS_HEADER_TC(h)      (((h)[2] >> 1) & 0x1)
#define DNS_HEADER_RD(h)      ((h)[2] & 0x1)
#define DNS_HEADER_RA(h)      (((h)[3] >> 7) & 0x1)
#define DNS_HEADER_Z(h)       (((h)[3] >> 4) & 0x7)
#define DNS_HEADER_RCODE(h)   ((h)[3] & 0xf)
#define DNS_HEADER_QDCOUNT(h) DNS__16BIT((h) + 4)
#define DNS_HEADER_ANCOUNT(h) DNS__16BIT((h) + 6)
#define DNS_HEADER_NSCOUNT(h) DNS__16BIT((h) + 8)
#define DNS_HEADER_ARCOUNT(h) DNS__16BIT((h) + 10)

/* Macros for constructing a DNS header */
#define DNS_HEADER_SET_QID(h, v) DNS__SET16BIT(h, v)
#define DNS_HEADER_SET_QR(h, v)  ((h)[2] |= (unsigned char)(((v) & 0x1) << 7))
#define DNS_HEADER_SET_OPCODE(h, v) \
  ((h)[2] |= (unsigned char)(((v) & 0xf) << 3))
#define DNS_HEADER_SET_AA(h, v)      ((h)[2] |= (unsigned char)(((v) & 0x1) << 2))
#define DNS_HEADER_SET_TC(h, v)      ((h)[2] |= (unsigned char)(((v) & 0x1) << 1))
#define DNS_HEADER_SET_RD(h, v)      ((h)[2] |= (unsigned char)((v) & 0x1))
#define DNS_HEADER_SET_RA(h, v)      ((h)[3] |= (unsigned char)(((v) & 0x1) << 7))
#define DNS_HEADER_SET_Z(h, v)       ((h)[3] |= (unsigned char)(((v) & 0x7) << 4))
#define DNS_HEADER_SET_RCODE(h, v)   ((h)[3] |= (unsigned char)((v) & 0xf))
#define DNS_HEADER_SET_QDCOUNT(h, v) DNS__SET16BIT((h) + 4, v)
#define DNS_HEADER_SET_ANCOUNT(h, v) DNS__SET16BIT((h) + 6, v)
#define DNS_HEADER_SET_NSCOUNT(h, v) DNS__SET16BIT((h) + 8, v)
#define DNS_HEADER_SET_ARCOUNT(h, v) DNS__SET16BIT((h) + 10, v)

/* Macros for parsing the fixed part of a DNS question */
#define DNS_QUESTION_TYPE(q)  DNS__16BIT(q)
#define DNS_QUESTION_CLASS(q) DNS__16BIT((q) + 2)

/* Macros for constructing the fixed part of a DNS question */
#define DNS_QUESTION_SET_TYPE(q, v)  DNS__SET16BIT(q, v)
#define DNS_QUESTION_SET_CLASS(q, v) DNS__SET16BIT((q) + 2, v)

/* Macros for parsing the fixed part of a DNS resource record */
#define DNS_RR_TYPE(r)  DNS__16BIT(r)
#define DNS_RR_CLASS(r) DNS__16BIT((r) + 2)
#define DNS_RR_TTL(r)   DNS__32BIT((r) + 4)
#define DNS_RR_LEN(r)   DNS__16BIT((r) + 8)

/* Macros for constructing the fixed part of a DNS resource record */
#define DNS_RR_SET_TYPE(r, v)  DNS__SET16BIT(r, v)
#define DNS_RR_SET_CLASS(r, v) DNS__SET16BIT((r) + 2, v)
#define DNS_RR_SET_TTL(r, v)   DNS__SET32BIT((r) + 4, v)
#define DNS_RR_SET_LEN(r, v)   DNS__SET16BIT((r) + 8, v)

#endif /* HEADER_CARES_DNS_H */
