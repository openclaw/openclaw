/*
 * Copyright 1995-2021 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_CONFTYPES_H
#define OPENSSL_CONFTYPES_H
#pragma once

#ifndef OPENSSL_CONF_H
#include <openssl/conf.h>
#endif

/*
 * The contents of this file are deprecated and will be made opaque
 */
struct conf_method_st {
    const char *name;
    CONF *(*create)(CONF_METHOD *meth);
    int (*init)(CONF *conf);
    int (*destroy)(CONF *conf);
    int (*destroy_data)(CONF *conf);
    int (*load_bio)(CONF *conf, BIO *bp, long *eline);
    int (*dump)(const CONF *conf, BIO *bp);
    int (*is_number)(const CONF *conf, char c);
    int (*to_int)(const CONF *conf, char c);
    int (*load)(CONF *conf, const char *name, long *eline);
};

struct conf_st {
    CONF_METHOD *meth;
    void *meth_data;
    LHASH_OF(CONF_VALUE) *data;
    int flag_dollarid;
    int flag_abspath;
    char *includedir;
    OSSL_LIB_CTX *libctx;
};

#endif
