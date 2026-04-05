/*
 * Copyright 2019-2023 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_CORE_H
#define OPENSSL_CORE_H
#pragma once

#include <stddef.h>
#include <openssl/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/*-
 * Base types
 * ----------
 *
 * These are the types that the OpenSSL core and providers have in common
 * to communicate data between them.
 */

/* Opaque handles to be used with core upcall functions from providers */
typedef struct ossl_core_handle_st OSSL_CORE_HANDLE;
typedef struct openssl_core_ctx_st OPENSSL_CORE_CTX;
typedef struct ossl_core_bio_st OSSL_CORE_BIO;

/*
 * Dispatch table element.  function_id numbers and the functions are defined
 * in core_dispatch.h, see macros with 'OSSL_CORE_MAKE_FUNC' in their names.
 *
 * An array of these is always terminated by function_id == 0
 */
struct ossl_dispatch_st {
    int function_id;
    void (*function)(void);
};

#define OSSL_DISPATCH_END \
    { 0, NULL }

/*
 * Other items, essentially an int<->pointer map element.
 *
 * We make this type distinct from OSSL_DISPATCH to ensure that dispatch
 * tables remain tables with function pointers only.
 *
 * This is used whenever we need to pass things like a table of error reason
 * codes <-> reason string maps, ...
 *
 * Usage determines which field works as key if any, rather than field order.
 *
 * An array of these is always terminated by id == 0 && ptr == NULL
 */
struct ossl_item_st {
    unsigned int id;
    void *ptr;
};

/*
 * Type to tie together algorithm names, property definition string and
 * the algorithm implementation in the form of a dispatch table.
 *
 * An array of these is always terminated by algorithm_names == NULL
 */
struct ossl_algorithm_st {
    const char *algorithm_names; /* key */
    const char *property_definition; /* key */
    const OSSL_DISPATCH *implementation;
    const char *algorithm_description;
};

/*
 * Type to pass object data in a uniform way, without exposing the object
 * structure.
 *
 * An array of these is always terminated by key == NULL
 */
struct ossl_param_st {
    const char *key; /* the name of the parameter */
    unsigned int data_type; /* declare what kind of content is in buffer */
    void *data; /* value being passed in or out */
    size_t data_size; /* data size */
    size_t return_size; /* returned content size */
};

/* Currently supported OSSL_PARAM data types */
/*
 * OSSL_PARAM_INTEGER and OSSL_PARAM_UNSIGNED_INTEGER
 * are arbitrary length and therefore require an arbitrarily sized buffer,
 * since they may be used to pass numbers larger than what is natively
 * available.
 *
 * The number must be buffered in native form, i.e. MSB first on B_ENDIAN
 * systems and LSB first on L_ENDIAN systems.  This means that arbitrary
 * native integers can be stored in the buffer, just make sure that the
 * buffer size is correct and the buffer itself is properly aligned (for
 * example by having the buffer field point at a C integer).
 */
#define OSSL_PARAM_INTEGER 1
#define OSSL_PARAM_UNSIGNED_INTEGER 2
/*-
 * OSSL_PARAM_REAL
 * is a C binary floating point values in native form and alignment.
 */
#define OSSL_PARAM_REAL 3
/*-
 * OSSL_PARAM_UTF8_STRING
 * is a printable string.  It is expected to be printed as it is.
 */
#define OSSL_PARAM_UTF8_STRING 4
/*-
 * OSSL_PARAM_OCTET_STRING
 * is a string of bytes with no further specification.  It is expected to be
 * printed as a hexdump.
 */
#define OSSL_PARAM_OCTET_STRING 5
/*-
 * OSSL_PARAM_UTF8_PTR
 * is a pointer to a printable string.  It is expected to be printed as it is.
 *
 * The difference between this and OSSL_PARAM_UTF8_STRING is that only pointers
 * are manipulated for this type.
 *
 * This is more relevant for parameter requests, where the responding
 * function doesn't need to copy the data to the provided buffer, but
 * sets the provided buffer to point at the actual data instead.
 *
 * WARNING!  Using these is FRAGILE, as it assumes that the actual
 * data and its location are constant.
 *
 * EXTRA WARNING!  If you are not completely sure you most likely want
 * to use the OSSL_PARAM_UTF8_STRING type.
 */
#define OSSL_PARAM_UTF8_PTR 6
/*-
 * OSSL_PARAM_OCTET_PTR
 * is a pointer to a string of bytes with no further specification.  It is
 * expected to be printed as a hexdump.
 *
 * The difference between this and OSSL_PARAM_OCTET_STRING is that only pointers
 * are manipulated for this type.
 *
 * This is more relevant for parameter requests, where the responding
 * function doesn't need to copy the data to the provided buffer, but
 * sets the provided buffer to point at the actual data instead.
 *
 * WARNING!  Using these is FRAGILE, as it assumes that the actual
 * data and its location are constant.
 *
 * EXTRA WARNING!  If you are not completely sure you most likely want
 * to use the OSSL_PARAM_OCTET_STRING type.
 */
#define OSSL_PARAM_OCTET_PTR 7

/*
 * Typedef for the thread stop handling callback. Used both internally and by
 * providers.
 *
 * Providers may register for notifications about threads stopping by
 * registering a callback to hear about such events. Providers register the
 * callback using the OSSL_FUNC_CORE_THREAD_START function in the |in| dispatch
 * table passed to OSSL_provider_init(). The arg passed back to a provider will
 * be the provider side context object.
 */
typedef void (*OSSL_thread_stop_handler_fn)(void *arg);

/*-
 * Provider entry point
 * --------------------
 *
 * This function is expected to be present in any dynamically loadable
 * provider module.  By definition, if this function doesn't exist in a
 * module, that module is not an OpenSSL provider module.
 */
/*-
 * |handle|     pointer to opaque type OSSL_CORE_HANDLE.  This can be used
 *              together with some functions passed via |in| to query data.
 * |in|         is the array of functions that the Core passes to the provider.
 * |out|        will be the array of base functions that the provider passes
 *              back to the Core.
 * |provctx|    a provider side context object, optionally created if the
 *              provider needs it.  This value is passed to other provider
 *              functions, notably other context constructors.
 */
typedef int(OSSL_provider_init_fn)(const OSSL_CORE_HANDLE *handle,
    const OSSL_DISPATCH *in,
    const OSSL_DISPATCH **out,
    void **provctx);
#ifdef __VMS
#pragma names save
#pragma names uppercase, truncated
#endif
OPENSSL_EXPORT OSSL_provider_init_fn OSSL_provider_init;
#ifdef __VMS
#pragma names restore
#endif

/*
 * Generic callback function signature.
 *
 * The expectation is that any provider function that wants to offer
 * a callback / hook can do so by taking an argument with this type,
 * as well as a pointer to caller-specific data.  When calling the
 * callback, the provider function can populate an OSSL_PARAM array
 * with data of its choice and pass that in the callback call, along
 * with the caller data argument.
 *
 * libcrypto may use the OSSL_PARAM array to create arguments for an
 * application callback it knows about.
 */
typedef int(OSSL_CALLBACK)(const OSSL_PARAM params[], void *arg);
typedef int(OSSL_INOUT_CALLBACK)(const OSSL_PARAM in_params[],
    OSSL_PARAM out_params[], void *arg);
/*
 * Passphrase callback function signature
 *
 * This is similar to the generic callback function above, but adds a
 * result parameter.
 */
typedef int(OSSL_PASSPHRASE_CALLBACK)(char *pass, size_t pass_size,
    size_t *pass_len,
    const OSSL_PARAM params[], void *arg);

#ifdef __cplusplus
}
#endif

#endif
