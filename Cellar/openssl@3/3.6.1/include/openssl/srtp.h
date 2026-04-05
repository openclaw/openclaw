/*
 * Copyright 2011-2016 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

/*
 * DTLS code by Eric Rescorla <ekr@rtfm.com>
 *
 * Copyright (C) 2006, Network Resonance, Inc. Copyright (C) 2011, RTFM, Inc.
 */

#ifndef OPENSSL_SRTP_H
#define OPENSSL_SRTP_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_D1_SRTP_H
#endif

#include <openssl/ssl.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SRTP_AES128_CM_SHA1_80 0x0001
#define SRTP_AES128_CM_SHA1_32 0x0002
#define SRTP_AES128_F8_SHA1_80 0x0003
#define SRTP_AES128_F8_SHA1_32 0x0004
#define SRTP_NULL_SHA1_80 0x0005
#define SRTP_NULL_SHA1_32 0x0006

/* AEAD SRTP protection profiles from RFC 7714 */
#define SRTP_AEAD_AES_128_GCM 0x0007
#define SRTP_AEAD_AES_256_GCM 0x0008

/* DOUBLE AEAD SRTP protection profiles from RFC 8723 */
#define SRTP_DOUBLE_AEAD_AES_128_GCM_AEAD_AES_128_GCM 0x0009
#define SRTP_DOUBLE_AEAD_AES_256_GCM_AEAD_AES_256_GCM 0x000A

/* ARIA SRTP protection profiles from RFC 8269 */
#define SRTP_ARIA_128_CTR_HMAC_SHA1_80 0x000B
#define SRTP_ARIA_128_CTR_HMAC_SHA1_32 0x000C
#define SRTP_ARIA_256_CTR_HMAC_SHA1_80 0x000D
#define SRTP_ARIA_256_CTR_HMAC_SHA1_32 0x000E
#define SRTP_AEAD_ARIA_128_GCM 0x000F
#define SRTP_AEAD_ARIA_256_GCM 0x0010

#ifndef OPENSSL_NO_SRTP

__owur int SSL_CTX_set_tlsext_use_srtp(SSL_CTX *ctx, const char *profiles);
__owur int SSL_set_tlsext_use_srtp(SSL *ssl, const char *profiles);

__owur STACK_OF(SRTP_PROTECTION_PROFILE) *SSL_get_srtp_profiles(SSL *ssl);
__owur SRTP_PROTECTION_PROFILE *SSL_get_selected_srtp_profile(SSL *s);

#endif

#ifdef __cplusplus
}
#endif

#endif
