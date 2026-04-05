/*
 * Copyright 2024-2025 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_ML_KEM_H
#define OPENSSL_ML_KEM_H
#pragma once

#define OSSL_ML_KEM_SHARED_SECRET_BYTES 32

#define OSSL_ML_KEM_512_BITS 512
#define OSSL_ML_KEM_512_SECURITY_BITS 128
#define OSSL_ML_KEM_512_CIPHERTEXT_BYTES 768
#define OSSL_ML_KEM_512_PUBLIC_KEY_BYTES 800

#define OSSL_ML_KEM_768_BITS 768
#define OSSL_ML_KEM_768_SECURITY_BITS 192
#define OSSL_ML_KEM_768_CIPHERTEXT_BYTES 1088
#define OSSL_ML_KEM_768_PUBLIC_KEY_BYTES 1184

#define OSSL_ML_KEM_1024_BITS 1024
#define OSSL_ML_KEM_1024_SECURITY_BITS 256
#define OSSL_ML_KEM_1024_CIPHERTEXT_BYTES 1568
#define OSSL_ML_KEM_1024_PUBLIC_KEY_BYTES 1568

#endif
