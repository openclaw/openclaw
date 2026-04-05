/*
 * Copyright 1995-2024 The OpenSSL Project Authors. All Rights Reserved.
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

/* clang-format off */

/* clang-format on */

/*
 * Header for dynamic hash table routines Author - Eric Young
 */

#ifndef OPENSSL_LHASH_H
#define OPENSSL_LHASH_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_LHASH_H
#endif

#include <openssl/e_os2.h>
#include <openssl/bio.h>
#ifndef OPENSSL_NO_STDIO
#include <stdio.h>
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef struct lhash_node_st OPENSSL_LH_NODE;
typedef int (*OPENSSL_LH_COMPFUNC)(const void *, const void *);
typedef int (*OPENSSL_LH_COMPFUNCTHUNK)(const void *, const void *, OPENSSL_LH_COMPFUNC cfn);
typedef unsigned long (*OPENSSL_LH_HASHFUNC)(const void *);
typedef unsigned long (*OPENSSL_LH_HASHFUNCTHUNK)(const void *, OPENSSL_LH_HASHFUNC hfn);
typedef void (*OPENSSL_LH_DOALL_FUNC)(void *);
typedef void (*OPENSSL_LH_DOALL_FUNC_THUNK)(void *, OPENSSL_LH_DOALL_FUNC doall);
typedef void (*OPENSSL_LH_DOALL_FUNCARG)(void *, void *);
typedef void (*OPENSSL_LH_DOALL_FUNCARG_THUNK)(void *, void *, OPENSSL_LH_DOALL_FUNCARG doall);
typedef struct lhash_st OPENSSL_LHASH;

/*
 * Macros for declaring and implementing type-safe wrappers for LHASH
 * callbacks. This way, callbacks can be provided to LHASH structures without
 * function pointer casting and the macro-defined callbacks provide
 * per-variable casting before deferring to the underlying type-specific
 * callbacks. NB: It is possible to place a "static" in front of both the
 * DECLARE and IMPLEMENT macros if the functions are strictly internal.
 */

/* First: "hash" functions */
#define DECLARE_LHASH_HASH_FN(name, o_type) \
    unsigned long name##_LHASH_HASH(const void *);
#define IMPLEMENT_LHASH_HASH_FN(name, o_type)        \
    unsigned long name##_LHASH_HASH(const void *arg) \
    {                                                \
        const o_type *a = arg;                       \
        return name##_hash(a);                       \
    }
#define LHASH_HASH_FN(name) name##_LHASH_HASH

/* Second: "compare" functions */
#define DECLARE_LHASH_COMP_FN(name, o_type) \
    int name##_LHASH_COMP(const void *, const void *);
#define IMPLEMENT_LHASH_COMP_FN(name, o_type)                 \
    int name##_LHASH_COMP(const void *arg1, const void *arg2) \
    {                                                         \
        const o_type *a = arg1;                               \
        const o_type *b = arg2;                               \
        return name##_cmp(a, b);                              \
    }
#define LHASH_COMP_FN(name) name##_LHASH_COMP

/* Fourth: "doall_arg" functions */
#define DECLARE_LHASH_DOALL_ARG_FN(name, o_type, a_type) \
    void name##_LHASH_DOALL_ARG(void *, void *);
#define IMPLEMENT_LHASH_DOALL_ARG_FN(name, o_type, a_type) \
    void name##_LHASH_DOALL_ARG(void *arg1, void *arg2)    \
    {                                                      \
        o_type *a = arg1;                                  \
        a_type *b = arg2;                                  \
        name##_doall_arg(a, b);                            \
    }
#define LHASH_DOALL_ARG_FN(name) name##_LHASH_DOALL_ARG

#define LH_LOAD_MULT 256

int OPENSSL_LH_error(OPENSSL_LHASH *lh);
OPENSSL_LHASH *OPENSSL_LH_new(OPENSSL_LH_HASHFUNC h, OPENSSL_LH_COMPFUNC c);
OPENSSL_LHASH *OPENSSL_LH_set_thunks(OPENSSL_LHASH *lh,
    OPENSSL_LH_HASHFUNCTHUNK hw,
    OPENSSL_LH_COMPFUNCTHUNK cw,
    OPENSSL_LH_DOALL_FUNC_THUNK daw,
    OPENSSL_LH_DOALL_FUNCARG_THUNK daaw);
void OPENSSL_LH_free(OPENSSL_LHASH *lh);
void OPENSSL_LH_flush(OPENSSL_LHASH *lh);
void *OPENSSL_LH_insert(OPENSSL_LHASH *lh, void *data);
void *OPENSSL_LH_delete(OPENSSL_LHASH *lh, const void *data);
void *OPENSSL_LH_retrieve(OPENSSL_LHASH *lh, const void *data);
void OPENSSL_LH_doall(OPENSSL_LHASH *lh, OPENSSL_LH_DOALL_FUNC func);
void OPENSSL_LH_doall_arg(OPENSSL_LHASH *lh,
    OPENSSL_LH_DOALL_FUNCARG func, void *arg);
void OPENSSL_LH_doall_arg_thunk(OPENSSL_LHASH *lh,
    OPENSSL_LH_DOALL_FUNCARG_THUNK daaw,
    OPENSSL_LH_DOALL_FUNCARG fn, void *arg);

unsigned long OPENSSL_LH_strhash(const char *c);
unsigned long OPENSSL_LH_num_items(const OPENSSL_LHASH *lh);
unsigned long OPENSSL_LH_get_down_load(const OPENSSL_LHASH *lh);
void OPENSSL_LH_set_down_load(OPENSSL_LHASH *lh, unsigned long down_load);

#ifndef OPENSSL_NO_STDIO
#ifndef OPENSSL_NO_DEPRECATED_3_1
OSSL_DEPRECATEDIN_3_1 void OPENSSL_LH_stats(const OPENSSL_LHASH *lh, FILE *fp);
OSSL_DEPRECATEDIN_3_1 void OPENSSL_LH_node_stats(const OPENSSL_LHASH *lh, FILE *fp);
OSSL_DEPRECATEDIN_3_1 void OPENSSL_LH_node_usage_stats(const OPENSSL_LHASH *lh, FILE *fp);
#endif
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_1
OSSL_DEPRECATEDIN_3_1 void OPENSSL_LH_stats_bio(const OPENSSL_LHASH *lh, BIO *out);
OSSL_DEPRECATEDIN_3_1 void OPENSSL_LH_node_stats_bio(const OPENSSL_LHASH *lh, BIO *out);
OSSL_DEPRECATEDIN_3_1 void OPENSSL_LH_node_usage_stats_bio(const OPENSSL_LHASH *lh, BIO *out);
#endif

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define _LHASH OPENSSL_LHASH
#define LHASH_NODE OPENSSL_LH_NODE
#define lh_error OPENSSL_LH_error
#define lh_new OPENSSL_LH_new
#define lh_free OPENSSL_LH_free
#define lh_insert OPENSSL_LH_insert
#define lh_delete OPENSSL_LH_delete
#define lh_retrieve OPENSSL_LH_retrieve
#define lh_doall OPENSSL_LH_doall
#define lh_doall_arg OPENSSL_LH_doall_arg
#define lh_strhash OPENSSL_LH_strhash
#define lh_num_items OPENSSL_LH_num_items
#ifndef OPENSSL_NO_STDIO
#define lh_stats OPENSSL_LH_stats
#define lh_node_stats OPENSSL_LH_node_stats
#define lh_node_usage_stats OPENSSL_LH_node_usage_stats
#endif
#define lh_stats_bio OPENSSL_LH_stats_bio
#define lh_node_stats_bio OPENSSL_LH_node_stats_bio
#define lh_node_usage_stats_bio OPENSSL_LH_node_usage_stats_bio
#endif

/* Type checking... */

#define LHASH_OF(type) struct lhash_st_##type

/* Helper macro for internal use */
#define DEFINE_LHASH_OF_INTERNAL(type)                                                                         \
    LHASH_OF(type)                                                                                             \
    {                                                                                                          \
        union lh_##type##_dummy {                                                                              \
            void *d1;                                                                                          \
            unsigned long d2;                                                                                  \
            int d3;                                                                                            \
        } dummy;                                                                                               \
    };                                                                                                         \
    typedef int (*lh_##type##_compfunc)(const type *a, const type *b);                                         \
    typedef unsigned long (*lh_##type##_hashfunc)(const type *a);                                              \
    typedef void (*lh_##type##_doallfunc)(type * a);                                                           \
    static ossl_inline unsigned long lh_##type##_hash_thunk(const void *data, OPENSSL_LH_HASHFUNC hfn)         \
    {                                                                                                          \
        unsigned long (*hfn_conv)(const type *) = (unsigned long (*)(const type *))hfn;                        \
        return hfn_conv((const type *)data);                                                                   \
    }                                                                                                          \
    static ossl_inline int lh_##type##_comp_thunk(const void *da, const void *db, OPENSSL_LH_COMPFUNC cfn)     \
    {                                                                                                          \
        int (*cfn_conv)(const type *, const type *) = (int (*)(const type *, const type *))cfn;                \
        return cfn_conv((const type *)da, (const type *)db);                                                   \
    }                                                                                                          \
    static ossl_inline void lh_##type##_doall_thunk(void *node, OPENSSL_LH_DOALL_FUNC doall)                   \
    {                                                                                                          \
        void (*doall_conv)(type *) = (void (*)(type *))doall;                                                  \
        doall_conv((type *)node);                                                                              \
    }                                                                                                          \
    static ossl_inline void lh_##type##_doall_arg_thunk(void *node, void *arg, OPENSSL_LH_DOALL_FUNCARG doall) \
    {                                                                                                          \
        void (*doall_conv)(type *, void *) = (void (*)(type *, void *))doall;                                  \
        doall_conv((type *)node, arg);                                                                         \
    }                                                                                                          \
    static ossl_unused ossl_inline type *                                                                      \
    ossl_check_##type##_lh_plain_type(type *ptr)                                                               \
    {                                                                                                          \
        return ptr;                                                                                            \
    }                                                                                                          \
    static ossl_unused ossl_inline const type *                                                                \
    ossl_check_const_##type##_lh_plain_type(const type *ptr)                                                   \
    {                                                                                                          \
        return ptr;                                                                                            \
    }                                                                                                          \
    static ossl_unused ossl_inline const OPENSSL_LHASH *                                                       \
    ossl_check_const_##type##_lh_type(const LHASH_OF(type) *lh)                                                \
    {                                                                                                          \
        return (const OPENSSL_LHASH *)lh;                                                                      \
    }                                                                                                          \
    static ossl_unused ossl_inline OPENSSL_LHASH *                                                             \
    ossl_check_##type##_lh_type(LHASH_OF(type) *lh)                                                            \
    {                                                                                                          \
        return (OPENSSL_LHASH *)lh;                                                                            \
    }                                                                                                          \
    static ossl_unused ossl_inline OPENSSL_LH_COMPFUNC                                                         \
    ossl_check_##type##_lh_compfunc_type(lh_##type##_compfunc cmp)                                             \
    {                                                                                                          \
        return (OPENSSL_LH_COMPFUNC)cmp;                                                                       \
    }                                                                                                          \
    static ossl_unused ossl_inline OPENSSL_LH_HASHFUNC                                                         \
    ossl_check_##type##_lh_hashfunc_type(lh_##type##_hashfunc hfn)                                             \
    {                                                                                                          \
        return (OPENSSL_LH_HASHFUNC)hfn;                                                                       \
    }                                                                                                          \
    static ossl_unused ossl_inline OPENSSL_LH_DOALL_FUNC                                                       \
    ossl_check_##type##_lh_doallfunc_type(lh_##type##_doallfunc dfn)                                           \
    {                                                                                                          \
        return (OPENSSL_LH_DOALL_FUNC)dfn;                                                                     \
    }                                                                                                          \
    LHASH_OF(type)

#ifndef OPENSSL_NO_DEPRECATED_3_1
#define DEFINE_LHASH_OF_DEPRECATED(type)                                 \
    static ossl_unused ossl_inline void                                  \
    lh_##type##_node_stats_bio(const LHASH_OF(type) *lh, BIO *out)       \
    {                                                                    \
        OPENSSL_LH_node_stats_bio((const OPENSSL_LHASH *)lh, out);       \
    }                                                                    \
    static ossl_unused ossl_inline void                                  \
    lh_##type##_node_usage_stats_bio(const LHASH_OF(type) *lh, BIO *out) \
    {                                                                    \
        OPENSSL_LH_node_usage_stats_bio((const OPENSSL_LHASH *)lh, out); \
    }                                                                    \
    static ossl_unused ossl_inline void                                  \
    lh_##type##_stats_bio(const LHASH_OF(type) *lh, BIO *out)            \
    {                                                                    \
        OPENSSL_LH_stats_bio((const OPENSSL_LHASH *)lh, out);            \
    }
#else
#define DEFINE_LHASH_OF_DEPRECATED(type)
#endif

#define DEFINE_LHASH_OF_EX(type)                                                                                           \
    LHASH_OF(type)                                                                                                         \
    {                                                                                                                      \
        union lh_##type##_dummy {                                                                                          \
            void *d1;                                                                                                      \
            unsigned long d2;                                                                                              \
            int d3;                                                                                                        \
        } dummy;                                                                                                           \
    };                                                                                                                     \
    static unsigned long                                                                                                   \
    lh_##type##_hfn_thunk(const void *data, OPENSSL_LH_HASHFUNC hfn)                                                       \
    {                                                                                                                      \
        unsigned long (*hfn_conv)(const type *) = (unsigned long (*)(const type *))hfn;                                    \
        return hfn_conv((const type *)data);                                                                               \
    }                                                                                                                      \
    static int lh_##type##_cfn_thunk(const void *da, const void *db, OPENSSL_LH_COMPFUNC cfn)                              \
    {                                                                                                                      \
        int (*cfn_conv)(const type *, const type *) = (int (*)(const type *, const type *))cfn;                            \
        return cfn_conv((const type *)da, (const type *)db);                                                               \
    }                                                                                                                      \
    static ossl_unused ossl_inline void                                                                                    \
    lh_##type##_free(LHASH_OF(type) *lh)                                                                                   \
    {                                                                                                                      \
        OPENSSL_LH_free((OPENSSL_LHASH *)lh);                                                                              \
    }                                                                                                                      \
    static ossl_unused ossl_inline void                                                                                    \
    lh_##type##_flush(LHASH_OF(type) *lh)                                                                                  \
    {                                                                                                                      \
        OPENSSL_LH_flush((OPENSSL_LHASH *)lh);                                                                             \
    }                                                                                                                      \
    static ossl_unused ossl_inline type *                                                                                  \
    lh_##type##_insert(LHASH_OF(type) *lh, type *d)                                                                        \
    {                                                                                                                      \
        return (type *)OPENSSL_LH_insert((OPENSSL_LHASH *)lh, d);                                                          \
    }                                                                                                                      \
    static ossl_unused ossl_inline type *                                                                                  \
    lh_##type##_delete(LHASH_OF(type) *lh, const type *d)                                                                  \
    {                                                                                                                      \
        return (type *)OPENSSL_LH_delete((OPENSSL_LHASH *)lh, d);                                                          \
    }                                                                                                                      \
    static ossl_unused ossl_inline type *                                                                                  \
    lh_##type##_retrieve(LHASH_OF(type) *lh, const type *d)                                                                \
    {                                                                                                                      \
        return (type *)OPENSSL_LH_retrieve((OPENSSL_LHASH *)lh, d);                                                        \
    }                                                                                                                      \
    static ossl_unused ossl_inline int                                                                                     \
    lh_##type##_error(LHASH_OF(type) *lh)                                                                                  \
    {                                                                                                                      \
        return OPENSSL_LH_error((OPENSSL_LHASH *)lh);                                                                      \
    }                                                                                                                      \
    static ossl_unused ossl_inline unsigned long                                                                           \
    lh_##type##_num_items(LHASH_OF(type) *lh)                                                                              \
    {                                                                                                                      \
        return OPENSSL_LH_num_items((OPENSSL_LHASH *)lh);                                                                  \
    }                                                                                                                      \
    static ossl_unused ossl_inline unsigned long                                                                           \
    lh_##type##_get_down_load(LHASH_OF(type) *lh)                                                                          \
    {                                                                                                                      \
        return OPENSSL_LH_get_down_load((OPENSSL_LHASH *)lh);                                                              \
    }                                                                                                                      \
    static ossl_unused ossl_inline void                                                                                    \
    lh_##type##_set_down_load(LHASH_OF(type) *lh, unsigned long dl)                                                        \
    {                                                                                                                      \
        OPENSSL_LH_set_down_load((OPENSSL_LHASH *)lh, dl);                                                                 \
    }                                                                                                                      \
    static ossl_unused ossl_inline void                                                                                    \
    lh_##type##_doall_thunk(void *node, OPENSSL_LH_DOALL_FUNC doall)                                                       \
    {                                                                                                                      \
        void (*doall_conv)(type *) = (void (*)(type *))doall;                                                              \
        doall_conv((type *)node);                                                                                          \
    }                                                                                                                      \
    static ossl_unused ossl_inline void                                                                                    \
    lh_##type##_doall_arg_thunk(void *node, void *arg, OPENSSL_LH_DOALL_FUNCARG doall)                                     \
    {                                                                                                                      \
        void (*doall_conv)(type *, void *) = (void (*)(type *, void *))doall;                                              \
        doall_conv((type *)node, arg);                                                                                     \
    }                                                                                                                      \
    static ossl_unused ossl_inline void                                                                                    \
    lh_##type##_doall(LHASH_OF(type) *lh, void (*doall)(type *))                                                           \
    {                                                                                                                      \
        OPENSSL_LH_doall((OPENSSL_LHASH *)lh, (OPENSSL_LH_DOALL_FUNC)doall);                                               \
    }                                                                                                                      \
    static ossl_unused ossl_inline LHASH_OF(type) *                                                                        \
    lh_##type##_new(unsigned long (*hfn)(const type *),                                                                    \
        int (*cfn)(const type *, const type *))                                                                            \
    {                                                                                                                      \
        return (LHASH_OF(type) *)OPENSSL_LH_set_thunks(OPENSSL_LH_new((OPENSSL_LH_HASHFUNC)hfn, (OPENSSL_LH_COMPFUNC)cfn), \
            lh_##type##_hfn_thunk, lh_##type##_cfn_thunk,                                                                  \
            lh_##type##_doall_thunk,                                                                                       \
            lh_##type##_doall_arg_thunk);                                                                                  \
    }                                                                                                                      \
    static ossl_unused ossl_inline void                                                                                    \
    lh_##type##_doall_arg(LHASH_OF(type) *lh,                                                                              \
        void (*doallarg)(type *, void *), void *arg)                                                                       \
    {                                                                                                                      \
        OPENSSL_LH_doall_arg((OPENSSL_LHASH *)lh,                                                                          \
            (OPENSSL_LH_DOALL_FUNCARG)doallarg, arg);                                                                      \
    }                                                                                                                      \
    LHASH_OF(type)

#define DEFINE_LHASH_OF(type)        \
    DEFINE_LHASH_OF_EX(type);        \
    DEFINE_LHASH_OF_DEPRECATED(type) \
    LHASH_OF(type)

#define IMPLEMENT_LHASH_DOALL_ARG_CONST(type, argtype) \
    int_implement_lhash_doall(type, argtype, const type)

#define IMPLEMENT_LHASH_DOALL_ARG(type, argtype) \
    int_implement_lhash_doall(type, argtype, type)

#define int_implement_lhash_doall(type, argtype, cbargtype)                                 \
    static ossl_unused ossl_inline void                                                     \
    lh_##type##_doall_##argtype##_thunk(void *node, void *arg, OPENSSL_LH_DOALL_FUNCARG fn) \
    {                                                                                       \
        void (*fn_conv)(cbargtype *, argtype *) = (void (*)(cbargtype *, argtype *))fn;     \
        fn_conv((cbargtype *)node, (argtype *)arg);                                         \
    }                                                                                       \
    static ossl_unused ossl_inline void                                                     \
    lh_##type##_doall_##argtype(LHASH_OF(type) *lh,                                         \
        void (*fn)(cbargtype *, argtype *),                                                 \
        argtype *arg)                                                                       \
    {                                                                                       \
        OPENSSL_LH_doall_arg_thunk((OPENSSL_LHASH *)lh,                                     \
            lh_##type##_doall_##argtype##_thunk,                                            \
            (OPENSSL_LH_DOALL_FUNCARG)fn,                                                   \
            (void *)arg);                                                                   \
    }                                                                                       \
    LHASH_OF(type)

/* clang-format off */
DEFINE_LHASH_OF_INTERNAL(OPENSSL_STRING);
#define lh_OPENSSL_STRING_new(hfn, cmp) ((LHASH_OF(OPENSSL_STRING) *)OPENSSL_LH_set_thunks(OPENSSL_LH_new(ossl_check_OPENSSL_STRING_lh_hashfunc_type(hfn), ossl_check_OPENSSL_STRING_lh_compfunc_type(cmp)), lh_OPENSSL_STRING_hash_thunk, lh_OPENSSL_STRING_comp_thunk, lh_OPENSSL_STRING_doall_thunk, lh_OPENSSL_STRING_doall_arg_thunk))
#define lh_OPENSSL_STRING_free(lh) OPENSSL_LH_free(ossl_check_OPENSSL_STRING_lh_type(lh))
#define lh_OPENSSL_STRING_flush(lh) OPENSSL_LH_flush(ossl_check_OPENSSL_STRING_lh_type(lh))
#define lh_OPENSSL_STRING_insert(lh, ptr) ((OPENSSL_STRING *)OPENSSL_LH_insert(ossl_check_OPENSSL_STRING_lh_type(lh), ossl_check_OPENSSL_STRING_lh_plain_type(ptr)))
#define lh_OPENSSL_STRING_delete(lh, ptr) ((OPENSSL_STRING *)OPENSSL_LH_delete(ossl_check_OPENSSL_STRING_lh_type(lh), ossl_check_const_OPENSSL_STRING_lh_plain_type(ptr)))
#define lh_OPENSSL_STRING_retrieve(lh, ptr) ((OPENSSL_STRING *)OPENSSL_LH_retrieve(ossl_check_OPENSSL_STRING_lh_type(lh), ossl_check_const_OPENSSL_STRING_lh_plain_type(ptr)))
#define lh_OPENSSL_STRING_error(lh) OPENSSL_LH_error(ossl_check_OPENSSL_STRING_lh_type(lh))
#define lh_OPENSSL_STRING_num_items(lh) OPENSSL_LH_num_items(ossl_check_OPENSSL_STRING_lh_type(lh))
#define lh_OPENSSL_STRING_node_stats_bio(lh, out) OPENSSL_LH_node_stats_bio(ossl_check_const_OPENSSL_STRING_lh_type(lh), out)
#define lh_OPENSSL_STRING_node_usage_stats_bio(lh, out) OPENSSL_LH_node_usage_stats_bio(ossl_check_const_OPENSSL_STRING_lh_type(lh), out)
#define lh_OPENSSL_STRING_stats_bio(lh, out) OPENSSL_LH_stats_bio(ossl_check_const_OPENSSL_STRING_lh_type(lh), out)
#define lh_OPENSSL_STRING_get_down_load(lh) OPENSSL_LH_get_down_load(ossl_check_OPENSSL_STRING_lh_type(lh))
#define lh_OPENSSL_STRING_set_down_load(lh, dl) OPENSSL_LH_set_down_load(ossl_check_OPENSSL_STRING_lh_type(lh), dl)
#define lh_OPENSSL_STRING_doall(lh, dfn) OPENSSL_LH_doall(ossl_check_OPENSSL_STRING_lh_type(lh), ossl_check_OPENSSL_STRING_lh_doallfunc_type(dfn))
DEFINE_LHASH_OF_INTERNAL(OPENSSL_CSTRING);
#define lh_OPENSSL_CSTRING_new(hfn, cmp) ((LHASH_OF(OPENSSL_CSTRING) *)OPENSSL_LH_set_thunks(OPENSSL_LH_new(ossl_check_OPENSSL_CSTRING_lh_hashfunc_type(hfn), ossl_check_OPENSSL_CSTRING_lh_compfunc_type(cmp)), lh_OPENSSL_CSTRING_hash_thunk, lh_OPENSSL_CSTRING_comp_thunk, lh_OPENSSL_CSTRING_doall_thunk, lh_OPENSSL_CSTRING_doall_arg_thunk))
#define lh_OPENSSL_CSTRING_free(lh) OPENSSL_LH_free(ossl_check_OPENSSL_CSTRING_lh_type(lh))
#define lh_OPENSSL_CSTRING_flush(lh) OPENSSL_LH_flush(ossl_check_OPENSSL_CSTRING_lh_type(lh))
#define lh_OPENSSL_CSTRING_insert(lh, ptr) ((OPENSSL_CSTRING *)OPENSSL_LH_insert(ossl_check_OPENSSL_CSTRING_lh_type(lh), ossl_check_OPENSSL_CSTRING_lh_plain_type(ptr)))
#define lh_OPENSSL_CSTRING_delete(lh, ptr) ((OPENSSL_CSTRING *)OPENSSL_LH_delete(ossl_check_OPENSSL_CSTRING_lh_type(lh), ossl_check_const_OPENSSL_CSTRING_lh_plain_type(ptr)))
#define lh_OPENSSL_CSTRING_retrieve(lh, ptr) ((OPENSSL_CSTRING *)OPENSSL_LH_retrieve(ossl_check_OPENSSL_CSTRING_lh_type(lh), ossl_check_const_OPENSSL_CSTRING_lh_plain_type(ptr)))
#define lh_OPENSSL_CSTRING_error(lh) OPENSSL_LH_error(ossl_check_OPENSSL_CSTRING_lh_type(lh))
#define lh_OPENSSL_CSTRING_num_items(lh) OPENSSL_LH_num_items(ossl_check_OPENSSL_CSTRING_lh_type(lh))
#define lh_OPENSSL_CSTRING_node_stats_bio(lh, out) OPENSSL_LH_node_stats_bio(ossl_check_const_OPENSSL_CSTRING_lh_type(lh), out)
#define lh_OPENSSL_CSTRING_node_usage_stats_bio(lh, out) OPENSSL_LH_node_usage_stats_bio(ossl_check_const_OPENSSL_CSTRING_lh_type(lh), out)
#define lh_OPENSSL_CSTRING_stats_bio(lh, out) OPENSSL_LH_stats_bio(ossl_check_const_OPENSSL_CSTRING_lh_type(lh), out)
#define lh_OPENSSL_CSTRING_get_down_load(lh) OPENSSL_LH_get_down_load(ossl_check_OPENSSL_CSTRING_lh_type(lh))
#define lh_OPENSSL_CSTRING_set_down_load(lh, dl) OPENSSL_LH_set_down_load(ossl_check_OPENSSL_CSTRING_lh_type(lh), dl)
#define lh_OPENSSL_CSTRING_doall(lh, dfn) OPENSSL_LH_doall(ossl_check_OPENSSL_CSTRING_lh_type(lh), ossl_check_OPENSSL_CSTRING_lh_doallfunc_type(dfn))

/* clang-format on */

#ifdef __cplusplus
}
#endif

#endif
