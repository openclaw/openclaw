/*
 * Copyright 2019-2021 The OpenSSL Project Authors. All Rights Reserved.
 * Copyright (c) 2019, Oracle and/or its affiliates.  All rights reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_PARAM_BUILD_H
#define OPENSSL_PARAM_BUILD_H
#pragma once

#include <openssl/params.h>
#include <openssl/types.h>

#ifdef __cplusplus
extern "C" {
#endif

OSSL_PARAM_BLD *OSSL_PARAM_BLD_new(void);
OSSL_PARAM *OSSL_PARAM_BLD_to_param(OSSL_PARAM_BLD *bld);
void OSSL_PARAM_BLD_free(OSSL_PARAM_BLD *bld);

int OSSL_PARAM_BLD_push_int(OSSL_PARAM_BLD *bld, const char *key, int val);
int OSSL_PARAM_BLD_push_uint(OSSL_PARAM_BLD *bld, const char *key,
    unsigned int val);
int OSSL_PARAM_BLD_push_long(OSSL_PARAM_BLD *bld, const char *key,
    long int val);
int OSSL_PARAM_BLD_push_ulong(OSSL_PARAM_BLD *bld, const char *key,
    unsigned long int val);
int OSSL_PARAM_BLD_push_int32(OSSL_PARAM_BLD *bld, const char *key,
    int32_t val);
int OSSL_PARAM_BLD_push_uint32(OSSL_PARAM_BLD *bld, const char *key,
    uint32_t val);
int OSSL_PARAM_BLD_push_int64(OSSL_PARAM_BLD *bld, const char *key,
    int64_t val);
int OSSL_PARAM_BLD_push_uint64(OSSL_PARAM_BLD *bld, const char *key,
    uint64_t val);
int OSSL_PARAM_BLD_push_size_t(OSSL_PARAM_BLD *bld, const char *key,
    size_t val);
int OSSL_PARAM_BLD_push_time_t(OSSL_PARAM_BLD *bld, const char *key,
    time_t val);
int OSSL_PARAM_BLD_push_double(OSSL_PARAM_BLD *bld, const char *key,
    double val);
int OSSL_PARAM_BLD_push_BN(OSSL_PARAM_BLD *bld, const char *key,
    const BIGNUM *bn);
int OSSL_PARAM_BLD_push_BN_pad(OSSL_PARAM_BLD *bld, const char *key,
    const BIGNUM *bn, size_t sz);
int OSSL_PARAM_BLD_push_utf8_string(OSSL_PARAM_BLD *bld, const char *key,
    const char *buf, size_t bsize);
int OSSL_PARAM_BLD_push_utf8_ptr(OSSL_PARAM_BLD *bld, const char *key,
    char *buf, size_t bsize);
int OSSL_PARAM_BLD_push_octet_string(OSSL_PARAM_BLD *bld, const char *key,
    const void *buf, size_t bsize);
int OSSL_PARAM_BLD_push_octet_ptr(OSSL_PARAM_BLD *bld, const char *key,
    void *buf, size_t bsize);

#ifdef __cplusplus
}
#endif
#endif /* OPENSSL_PARAM_BUILD_H */
