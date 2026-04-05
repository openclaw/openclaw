/*
 * Copyright 1999-2021 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_SYMHACKS_H
#define OPENSSL_SYMHACKS_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_SYMHACKS_H
#endif

#include <openssl/e_os2.h>

/* Case insensitive linking causes problems.... */
#if defined(OPENSSL_SYS_VMS)
#undef ERR_load_CRYPTO_strings
#define ERR_load_CRYPTO_strings ERR_load_CRYPTOlib_strings
#undef OCSP_crlID_new
#define OCSP_crlID_new OCSP_crlID2_new

#undef d2i_ECPARAMETERS
#define d2i_ECPARAMETERS d2i_UC_ECPARAMETERS
#undef i2d_ECPARAMETERS
#define i2d_ECPARAMETERS i2d_UC_ECPARAMETERS
#undef d2i_ECPKPARAMETERS
#define d2i_ECPKPARAMETERS d2i_UC_ECPKPARAMETERS
#undef i2d_ECPKPARAMETERS
#define i2d_ECPKPARAMETERS i2d_UC_ECPKPARAMETERS

#endif

#endif /* ! defined HEADER_VMS_IDHACKS_H */
