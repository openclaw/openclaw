/*
 * Copyright 2021-2023 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_PROV_SSL_H
#define OPENSSL_PROV_SSL_H
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/* SSL/TLS related defines useful to providers */

#define SSL_MAX_MASTER_KEY_LENGTH 48

/* SSL/TLS uses a 2 byte unsigned version number */
#define SSL3_VERSION 0x0300
#define TLS1_VERSION 0x0301
#define TLS1_1_VERSION 0x0302
#define TLS1_2_VERSION 0x0303
#define TLS1_3_VERSION 0x0304
#define DTLS1_VERSION 0xFEFF
#define DTLS1_2_VERSION 0xFEFD
#define DTLS1_BAD_VER 0x0100

/* QUIC uses a 4 byte unsigned version number */
#define OSSL_QUIC1_VERSION 0x0000001

#ifdef __cplusplus
}
#endif
#endif /* OPENSSL_PROV_SSL_H */
