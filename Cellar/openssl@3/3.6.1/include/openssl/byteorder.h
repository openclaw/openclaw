/*
 * Copyright 2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_BYTEORDER_H
#define OPENSSL_BYTEORDER_H
#pragma once

#include <openssl/e_os2.h>
#include <string.h>

/*
 * "Modern" compilers do a decent job of optimising these functions to just a
 * couple of instruction ([swap +] store, or load [+ swap]) when either no
 * swapping is required, or a suitable swap instruction is available.
 */

#if defined(_MSC_VER) && _MSC_VER >= 1300
#include <stdlib.h>
#pragma intrinsic(_byteswap_ushort)
#pragma intrinsic(_byteswap_ulong)
#pragma intrinsic(_byteswap_uint64)
#define OSSL_HTOBE16(x) _byteswap_ushort(x)
#define OSSL_HTOBE32(x) _byteswap_ulong(x)
#define OSSL_HTOBE64(x) _byteswap_uint64(x)
#define OSSL_BE16TOH(x) _byteswap_ushort(x)
#define OSSL_BE32TOH(x) _byteswap_ulong(x)
#define OSSL_BE64TOH(x) _byteswap_uint64(x)
#define OSSL_HTOLE16(x) (x)
#define OSSL_HTOLE32(x) (x)
#define OSSL_HTOLE64(x) (x)
#define OSSL_LE16TOH(x) (x)
#define OSSL_LE32TOH(x) (x)
#define OSSL_LE64TOH(x) (x)

#elif defined(__GLIBC__) && defined(__GLIBC_PREREQ)
#if (__GLIBC_PREREQ(2, 19)) && defined(_DEFAULT_SOURCE)
#include <endian.h>
#define OSSL_HTOBE16(x) htobe16(x)
#define OSSL_HTOBE32(x) htobe32(x)
#define OSSL_HTOBE64(x) htobe64(x)
#define OSSL_BE16TOH(x) be16toh(x)
#define OSSL_BE32TOH(x) be32toh(x)
#define OSSL_BE64TOH(x) be64toh(x)
#define OSSL_HTOLE16(x) htole16(x)
#define OSSL_HTOLE32(x) htole32(x)
#define OSSL_HTOLE64(x) htole64(x)
#define OSSL_LE16TOH(x) le16toh(x)
#define OSSL_LE32TOH(x) le32toh(x)
#define OSSL_LE64TOH(x) le64toh(x)
#endif

#elif defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)
#if defined(__OpenBSD__)
#include <sys/types.h>
#else
#include <sys/endian.h>
#endif
#define OSSL_HTOBE16(x) htobe16(x)
#define OSSL_HTOBE32(x) htobe32(x)
#define OSSL_HTOBE64(x) htobe64(x)
#define OSSL_BE16TOH(x) be16toh(x)
#define OSSL_BE32TOH(x) be32toh(x)
#define OSSL_BE64TOH(x) be64toh(x)
#define OSSL_HTOLE16(x) htole16(x)
#define OSSL_HTOLE32(x) htole32(x)
#define OSSL_HTOLE64(x) htole64(x)
#define OSSL_LE16TOH(x) le16toh(x)
#define OSSL_LE32TOH(x) le32toh(x)
#define OSSL_LE64TOH(x) le64toh(x)

#elif defined(__APPLE__)
#include <libkern/OSByteOrder.h>
#define OSSL_HTOBE16(x) OSSwapHostToBigInt16(x)
#define OSSL_HTOBE32(x) OSSwapHostToBigInt32(x)
#define OSSL_HTOBE64(x) OSSwapHostToBigInt64(x)
#define OSSL_BE16TOH(x) OSSwapBigToHostInt16(x)
#define OSSL_BE32TOH(x) OSSwapBigToHostInt32(x)
#define OSSL_BE64TOH(x) OSSwapBigToHostInt64(x)
#define OSSL_HTOLE16(x) OSSwapHostToLittleInt16(x)
#define OSSL_HTOLE32(x) OSSwapHostToLittleInt32(x)
#define OSSL_HTOLE64(x) OSSwapHostToLittleInt64(x)
#define OSSL_LE16TOH(x) OSSwapLittleToHostInt16(x)
#define OSSL_LE32TOH(x) OSSwapLittleToHostInt32(x)
#define OSSL_LE64TOH(x) OSSwapLittleToHostInt64(x)

#endif

static ossl_inline ossl_unused unsigned char *
OPENSSL_store_u16_le(unsigned char *out, uint16_t val)
{
#ifdef OSSL_HTOLE16
    uint16_t t = OSSL_HTOLE16(val);

    memcpy(out, (unsigned char *)&t, 2);
    return out + 2;
#else
    *out++ = (val & 0xff);
    *out++ = (val >> 8) & 0xff;
    return out;
#endif
}

static ossl_inline ossl_unused unsigned char *
OPENSSL_store_u16_be(unsigned char *out, uint16_t val)
{
#ifdef OSSL_HTOBE16
    uint16_t t = OSSL_HTOBE16(val);

    memcpy(out, (unsigned char *)&t, 2);
    return out + 2;
#else
    *out++ = (val >> 8) & 0xff;
    *out++ = (val & 0xff);
    return out;
#endif
}

static ossl_inline ossl_unused unsigned char *
OPENSSL_store_u32_le(unsigned char *out, uint32_t val)
{
#ifdef OSSL_HTOLE32
    uint32_t t = OSSL_HTOLE32(val);

    memcpy(out, (unsigned char *)&t, 4);
    return out + 4;
#else
    *out++ = (val & 0xff);
    *out++ = (val >> 8) & 0xff;
    *out++ = (val >> 16) & 0xff;
    *out++ = (val >> 24) & 0xff;
    return out;
#endif
}

static ossl_inline ossl_unused unsigned char *
OPENSSL_store_u32_be(unsigned char *out, uint32_t val)
{
#ifdef OSSL_HTOBE32
    uint32_t t = OSSL_HTOBE32(val);

    memcpy(out, (unsigned char *)&t, 4);
    return out + 4;
#else
    *out++ = (val >> 24) & 0xff;
    *out++ = (val >> 16) & 0xff;
    *out++ = (val >> 8) & 0xff;
    *out++ = (val & 0xff);
    return out;
#endif
}

static ossl_inline ossl_unused unsigned char *
OPENSSL_store_u64_le(unsigned char *out, uint64_t val)
{
#ifdef OSSL_HTOLE64
    uint64_t t = OSSL_HTOLE64(val);

    memcpy(out, (unsigned char *)&t, 8);
    return out + 8;
#else
    *out++ = (val & 0xff);
    *out++ = (val >> 8) & 0xff;
    *out++ = (val >> 16) & 0xff;
    *out++ = (val >> 24) & 0xff;
    *out++ = (val >> 32) & 0xff;
    *out++ = (val >> 40) & 0xff;
    *out++ = (val >> 48) & 0xff;
    *out++ = (val >> 56) & 0xff;
    return out;
#endif
}

static ossl_inline ossl_unused unsigned char *
OPENSSL_store_u64_be(unsigned char *out, uint64_t val)
{
#ifdef OSSL_HTOLE64
    uint64_t t = OSSL_HTOBE64(val);

    memcpy(out, (unsigned char *)&t, 8);
    return out + 8;
#else
    *out++ = (val >> 56) & 0xff;
    *out++ = (val >> 48) & 0xff;
    *out++ = (val >> 40) & 0xff;
    *out++ = (val >> 32) & 0xff;
    *out++ = (val >> 24) & 0xff;
    *out++ = (val >> 16) & 0xff;
    *out++ = (val >> 8) & 0xff;
    *out++ = (val & 0xff);
    return out;
#endif
}

static ossl_inline ossl_unused const unsigned char *
OPENSSL_load_u16_le(uint16_t *val, const unsigned char *in)
{
#ifdef OSSL_LE16TOH
    uint16_t t;

    memcpy((unsigned char *)&t, in, 2);
    *val = OSSL_LE16TOH(t);
    return in + 2;
#else
    uint16_t b0 = *in++;
    uint16_t b1 = *in++;

    *val = b0 | (b1 << 8);
    return in;
#endif
}

static ossl_inline ossl_unused const unsigned char *
OPENSSL_load_u16_be(uint16_t *val, const unsigned char *in)
{
#ifdef OSSL_LE16TOH
    uint16_t t;

    memcpy((unsigned char *)&t, in, 2);
    *val = OSSL_BE16TOH(t);
    return in + 2;
#else
    uint16_t b1 = *in++;
    uint16_t b0 = *in++;

    *val = b0 | (b1 << 8);
    return in;
#endif
}

static ossl_inline ossl_unused const unsigned char *
OPENSSL_load_u32_le(uint32_t *val, const unsigned char *in)
{
#ifdef OSSL_LE32TOH
    uint32_t t;

    memcpy((unsigned char *)&t, in, 4);
    *val = OSSL_LE32TOH(t);
    return in + 4;
#else
    uint32_t b0 = *in++;
    uint32_t b1 = *in++;
    uint32_t b2 = *in++;
    uint32_t b3 = *in++;

    *val = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    return in;
#endif
}

static ossl_inline ossl_unused const unsigned char *
OPENSSL_load_u32_be(uint32_t *val, const unsigned char *in)
{
#ifdef OSSL_LE32TOH
    uint32_t t;

    memcpy((unsigned char *)&t, in, 4);
    *val = OSSL_BE32TOH(t);
    return in + 4;
#else
    uint32_t b3 = *in++;
    uint32_t b2 = *in++;
    uint32_t b1 = *in++;
    uint32_t b0 = *in++;

    *val = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24);
    return in;
#endif
}

static ossl_inline ossl_unused const unsigned char *
OPENSSL_load_u64_le(uint64_t *val, const unsigned char *in)
{
#ifdef OSSL_LE64TOH
    uint64_t t;

    memcpy((unsigned char *)&t, in, 8);
    *val = OSSL_LE64TOH(t);
    return in + 8;
#else
    uint64_t b0 = *in++;
    uint64_t b1 = *in++;
    uint64_t b2 = *in++;
    uint64_t b3 = *in++;
    uint64_t b4 = *in++;
    uint64_t b5 = *in++;
    uint64_t b6 = *in++;
    uint64_t b7 = *in++;

    *val = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
        | (b4 << 32) | (b5 << 40) | (b6 << 48) | (b7 << 56);
    return in;
#endif
}

static ossl_inline ossl_unused const unsigned char *
OPENSSL_load_u64_be(uint64_t *val, const unsigned char *in)
{
#ifdef OSSL_LE64TOH
    uint64_t t;

    memcpy((unsigned char *)&t, in, 8);
    *val = OSSL_BE64TOH(t);
    return in + 8;
#else
    uint64_t b7 = *in++;
    uint64_t b6 = *in++;
    uint64_t b5 = *in++;
    uint64_t b4 = *in++;
    uint64_t b3 = *in++;
    uint64_t b2 = *in++;
    uint64_t b1 = *in++;
    uint64_t b0 = *in++;

    *val = b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
        | (b4 << 32) | (b5 << 40) | (b6 << 48) | (b7 << 56);
    return in;
#endif
}

#undef OSSL_HTOBE16
#undef OSSL_HTOBE32
#undef OSSL_HTOBE64
#undef OSSL_BE16TOH
#undef OSSL_BE32TOH
#undef OSSL_BE64TOH
#undef OSSL_HTOLE16
#undef OSSL_HTOLE32
#undef OSSL_HTOLE64
#undef OSSL_LE16TOH
#undef OSSL_LE32TOH
#undef OSSL_LE64TOH

#endif
