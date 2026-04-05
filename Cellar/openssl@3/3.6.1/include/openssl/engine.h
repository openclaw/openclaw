/*
 * Copyright 2000-2022 The OpenSSL Project Authors. All Rights Reserved.
 * Copyright (c) 2002, Oracle and/or its affiliates. All rights reserved
 *
 * Licensed under the Apache License 2.0 (the "License").  You may not use
 * this file except in compliance with the License.  You can obtain a copy
 * in the file LICENSE in the source distribution or at
 * https://www.openssl.org/source/license.html
 */

#ifndef OPENSSL_ENGINE_H
#define OPENSSL_ENGINE_H
#pragma once

#include <openssl/macros.h>
#ifndef OPENSSL_NO_DEPRECATED_3_0
#define HEADER_ENGINE_H
#endif

#include <openssl/opensslconf.h>

#ifndef OPENSSL_NO_ENGINE
#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#include <openssl/bn.h>
#include <openssl/rsa.h>
#include <openssl/dsa.h>
#include <openssl/dh.h>
#include <openssl/ec.h>
#include <openssl/rand.h>
#include <openssl/ui.h>
#include <openssl/err.h>
#endif
#include <openssl/types.h>
#include <openssl/symhacks.h>
#include <openssl/x509.h>
#include <openssl/engineerr.h>
#ifdef __cplusplus
extern "C" {
#endif

/*
 * These flags are used to control combinations of algorithm (methods) by
 * bitwise "OR"ing.
 */
#define ENGINE_METHOD_RSA (unsigned int)0x0001
#define ENGINE_METHOD_DSA (unsigned int)0x0002
#define ENGINE_METHOD_DH (unsigned int)0x0004
#define ENGINE_METHOD_RAND (unsigned int)0x0008
#define ENGINE_METHOD_CIPHERS (unsigned int)0x0040
#define ENGINE_METHOD_DIGESTS (unsigned int)0x0080
#define ENGINE_METHOD_PKEY_METHS (unsigned int)0x0200
#define ENGINE_METHOD_PKEY_ASN1_METHS (unsigned int)0x0400
#define ENGINE_METHOD_EC (unsigned int)0x0800
/* Obvious all-or-nothing cases. */
#define ENGINE_METHOD_ALL (unsigned int)0xFFFF
#define ENGINE_METHOD_NONE (unsigned int)0x0000

/*
 * This(ese) flag(s) controls behaviour of the ENGINE_TABLE mechanism used
 * internally to control registration of ENGINE implementations, and can be
 * set by ENGINE_set_table_flags(). The "NOINIT" flag prevents attempts to
 * initialise registered ENGINEs if they are not already initialised.
 */
#define ENGINE_TABLE_FLAG_NOINIT (unsigned int)0x0001

/* ENGINE flags that can be set by ENGINE_set_flags(). */
/* Not used */
/* #define ENGINE_FLAGS_MALLOCED        0x0001 */

/*
 * This flag is for ENGINEs that wish to handle the various 'CMD'-related
 * control commands on their own. Without this flag, ENGINE_ctrl() handles
 * these control commands on behalf of the ENGINE using their "cmd_defns"
 * data.
 */
#define ENGINE_FLAGS_MANUAL_CMD_CTRL (int)0x0002

/*
 * This flag is for ENGINEs who return new duplicate structures when found
 * via "ENGINE_by_id()". When an ENGINE must store state (eg. if
 * ENGINE_ctrl() commands are called in sequence as part of some stateful
 * process like key-generation setup and execution), it can set this flag -
 * then each attempt to obtain the ENGINE will result in it being copied into
 * a new structure. Normally, ENGINEs don't declare this flag so
 * ENGINE_by_id() just increments the existing ENGINE's structural reference
 * count.
 */
#define ENGINE_FLAGS_BY_ID_COPY (int)0x0004

/*
 * This flag is for an ENGINE that does not want its methods registered as
 * part of ENGINE_register_all_complete() for example if the methods are not
 * usable as default methods.
 */

#define ENGINE_FLAGS_NO_REGISTER_ALL (int)0x0008

/*
 * ENGINEs can support their own command types, and these flags are used in
 * ENGINE_CTRL_GET_CMD_FLAGS to indicate to the caller what kind of input
 * each command expects. Currently only numeric and string input is
 * supported. If a control command supports none of the _NUMERIC, _STRING, or
 * _NO_INPUT options, then it is regarded as an "internal" control command -
 * and not for use in config setting situations. As such, they're not
 * available to the ENGINE_ctrl_cmd_string() function, only raw ENGINE_ctrl()
 * access. Changes to this list of 'command types' should be reflected
 * carefully in ENGINE_cmd_is_executable() and ENGINE_ctrl_cmd_string().
 */

/* accepts a 'long' input value (3rd parameter to ENGINE_ctrl) */
#define ENGINE_CMD_FLAG_NUMERIC (unsigned int)0x0001
/*
 * accepts string input (cast from 'void*' to 'const char *', 4th parameter
 * to ENGINE_ctrl)
 */
#define ENGINE_CMD_FLAG_STRING (unsigned int)0x0002
/*
 * Indicates that the control command takes *no* input. Ie. the control
 * command is unparameterised.
 */
#define ENGINE_CMD_FLAG_NO_INPUT (unsigned int)0x0004
/*
 * Indicates that the control command is internal. This control command won't
 * be shown in any output, and is only usable through the ENGINE_ctrl_cmd()
 * function.
 */
#define ENGINE_CMD_FLAG_INTERNAL (unsigned int)0x0008

/*
 * NB: These 3 control commands are deprecated and should not be used.
 * ENGINEs relying on these commands should compile conditional support for
 * compatibility (eg. if these symbols are defined) but should also migrate
 * the same functionality to their own ENGINE-specific control functions that
 * can be "discovered" by calling applications. The fact these control
 * commands wouldn't be "executable" (ie. usable by text-based config)
 * doesn't change the fact that application code can find and use them
 * without requiring per-ENGINE hacking.
 */

/*
 * These flags are used to tell the ctrl function what should be done. All
 * command numbers are shared between all engines, even if some don't make
 * sense to some engines.  In such a case, they do nothing but return the
 * error ENGINE_R_CTRL_COMMAND_NOT_IMPLEMENTED.
 */
#define ENGINE_CTRL_SET_LOGSTREAM 1
#define ENGINE_CTRL_SET_PASSWORD_CALLBACK 2
#define ENGINE_CTRL_HUP 3 /* Close and reinitialise  \
                           * any handles/connections \
                           * etc. */
#define ENGINE_CTRL_SET_USER_INTERFACE 4 /* Alternative to callback */
#define ENGINE_CTRL_SET_CALLBACK_DATA 5 /* User-specific data, used  \
                                         * when calling the password \
                                         * callback and the user     \
                                         * interface */
#define ENGINE_CTRL_LOAD_CONFIGURATION 6 /* Load a configuration,  \
                                          * given a string that    \
                                          * represents a file name \
                                          * or so */
#define ENGINE_CTRL_LOAD_SECTION 7 /* Load data from a given \
                                    * section in the already \
                                    * loaded configuration */

/*
 * These control commands allow an application to deal with an arbitrary
 * engine in a dynamic way. Warn: Negative return values indicate errors FOR
 * THESE COMMANDS because zero is used to indicate 'end-of-list'. Other
 * commands, including ENGINE-specific command types, return zero for an
 * error. An ENGINE can choose to implement these ctrl functions, and can
 * internally manage things however it chooses - it does so by setting the
 * ENGINE_FLAGS_MANUAL_CMD_CTRL flag (using ENGINE_set_flags()). Otherwise
 * the ENGINE_ctrl() code handles this on the ENGINE's behalf using the
 * cmd_defns data (set using ENGINE_set_cmd_defns()). This means an ENGINE's
 * ctrl() handler need only implement its own commands - the above "meta"
 * commands will be taken care of.
 */

/*
 * Returns non-zero if the supplied ENGINE has a ctrl() handler. If "not",
 * then all the remaining control commands will return failure, so it is
 * worth checking this first if the caller is trying to "discover" the
 * engine's capabilities and doesn't want errors generated unnecessarily.
 */
#define ENGINE_CTRL_HAS_CTRL_FUNCTION 10
/*
 * Returns a positive command number for the first command supported by the
 * engine. Returns zero if no ctrl commands are supported.
 */
#define ENGINE_CTRL_GET_FIRST_CMD_TYPE 11
/*
 * The 'long' argument specifies a command implemented by the engine, and the
 * return value is the next command supported, or zero if there are no more.
 */
#define ENGINE_CTRL_GET_NEXT_CMD_TYPE 12
/*
 * The 'void*' argument is a command name (cast from 'const char *'), and the
 * return value is the command that corresponds to it.
 */
#define ENGINE_CTRL_GET_CMD_FROM_NAME 13
/*
 * The next two allow a command to be converted into its corresponding string
 * form. In each case, the 'long' argument supplies the command. In the
 * NAME_LEN case, the return value is the length of the command name (not
 * counting a trailing EOL). In the NAME case, the 'void*' argument must be a
 * string buffer large enough, and it will be populated with the name of the
 * command (WITH a trailing EOL).
 */
#define ENGINE_CTRL_GET_NAME_LEN_FROM_CMD 14
#define ENGINE_CTRL_GET_NAME_FROM_CMD 15
/* The next two are similar but give a "short description" of a command. */
#define ENGINE_CTRL_GET_DESC_LEN_FROM_CMD 16
#define ENGINE_CTRL_GET_DESC_FROM_CMD 17
/*
 * With this command, the return value is the OR'd combination of
 * ENGINE_CMD_FLAG_*** values that indicate what kind of input a given
 * engine-specific ctrl command expects.
 */
#define ENGINE_CTRL_GET_CMD_FLAGS 18

/*
 * ENGINE implementations should start the numbering of their own control
 * commands from this value. (ie. ENGINE_CMD_BASE, ENGINE_CMD_BASE + 1, etc).
 */
#define ENGINE_CMD_BASE 200

/*
 * NB: These 2 nCipher "chil" control commands are deprecated, and their
 * functionality is now available through ENGINE-specific control commands
 * (exposed through the above-mentioned 'CMD'-handling). Code using these 2
 * commands should be migrated to the more general command handling before
 * these are removed.
 */

/* Flags specific to the nCipher "chil" engine */
#define ENGINE_CTRL_CHIL_SET_FORKCHECK 100
/*
 * Depending on the value of the (long)i argument, this sets or
 * unsets the SimpleForkCheck flag in the CHIL API to enable or
 * disable checking and workarounds for applications that fork().
 */
#define ENGINE_CTRL_CHIL_NO_LOCKING 101
/*
 * This prevents the initialisation function from providing mutex
 * callbacks to the nCipher library.
 */

/*
 * If an ENGINE supports its own specific control commands and wishes the
 * framework to handle the above 'ENGINE_CMD_***'-manipulation commands on
 * its behalf, it should supply a null-terminated array of ENGINE_CMD_DEFN
 * entries to ENGINE_set_cmd_defns(). It should also implement a ctrl()
 * handler that supports the stated commands (ie. the "cmd_num" entries as
 * described by the array). NB: The array must be ordered in increasing order
 * of cmd_num. "null-terminated" means that the last ENGINE_CMD_DEFN element
 * has cmd_num set to zero and/or cmd_name set to NULL.
 */
typedef struct ENGINE_CMD_DEFN_st {
    unsigned int cmd_num; /* The command number */
    const char *cmd_name; /* The command name itself */
    const char *cmd_desc; /* A short description of the command */
    unsigned int cmd_flags; /* The input the command expects */
} ENGINE_CMD_DEFN;

/* Generic function pointer */
typedef int (*ENGINE_GEN_FUNC_PTR)(void);
/* Generic function pointer taking no arguments */
typedef int (*ENGINE_GEN_INT_FUNC_PTR)(ENGINE *);
/* Specific control function pointer */
typedef int (*ENGINE_CTRL_FUNC_PTR)(ENGINE *, int, long, void *,
    void (*f)(void));
/* Generic load_key function pointer */
typedef EVP_PKEY *(*ENGINE_LOAD_KEY_PTR)(ENGINE *, const char *,
    UI_METHOD *ui_method,
    void *callback_data);
typedef int (*ENGINE_SSL_CLIENT_CERT_PTR)(ENGINE *, SSL *ssl,
    STACK_OF(X509_NAME) *ca_dn,
    X509 **pcert, EVP_PKEY **pkey,
    STACK_OF(X509) **pother,
    UI_METHOD *ui_method,
    void *callback_data);
/*-
 * These callback types are for an ENGINE's handler for cipher and digest logic.
 * These handlers have these prototypes;
 *   int foo(ENGINE *e, const EVP_CIPHER **cipher, const int **nids, int nid);
 *   int foo(ENGINE *e, const EVP_MD **digest, const int **nids, int nid);
 * Looking at how to implement these handlers in the case of cipher support, if
 * the framework wants the EVP_CIPHER for 'nid', it will call;
 *   foo(e, &p_evp_cipher, NULL, nid);    (return zero for failure)
 * If the framework wants a list of supported 'nid's, it will call;
 *   foo(e, NULL, &p_nids, 0); (returns number of 'nids' or -1 for error)
 */
/*
 * Returns to a pointer to the array of supported cipher 'nid's. If the
 * second parameter is non-NULL it is set to the size of the returned array.
 */
typedef int (*ENGINE_CIPHERS_PTR)(ENGINE *, const EVP_CIPHER **,
    const int **, int);
typedef int (*ENGINE_DIGESTS_PTR)(ENGINE *, const EVP_MD **, const int **,
    int);
typedef int (*ENGINE_PKEY_METHS_PTR)(ENGINE *, EVP_PKEY_METHOD **,
    const int **, int);
typedef int (*ENGINE_PKEY_ASN1_METHS_PTR)(ENGINE *, EVP_PKEY_ASN1_METHOD **,
    const int **, int);
/*
 * STRUCTURE functions ... all of these functions deal with pointers to
 * ENGINE structures where the pointers have a "structural reference". This
 * means that their reference is to allowed access to the structure but it
 * does not imply that the structure is functional. To simply increment or
 * decrement the structural reference count, use ENGINE_by_id and
 * ENGINE_free. NB: This is not required when iterating using ENGINE_get_next
 * as it will automatically decrement the structural reference count of the
 * "current" ENGINE and increment the structural reference count of the
 * ENGINE it returns (unless it is NULL).
 */

/* Get the first/last "ENGINE" type available. */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_first(void);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_last(void);
#endif
/* Iterate to the next/previous "ENGINE" type (NULL = end of the list). */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_next(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_prev(ENGINE *e);
#endif
/* Add another "ENGINE" type into the array. */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_add(ENGINE *e);
#endif
/* Remove an existing "ENGINE" type from the array. */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_remove(ENGINE *e);
#endif
/* Retrieve an engine from the list by its unique "id" value. */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_by_id(const char *id);
#endif

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
#define ENGINE_load_openssl() \
    OPENSSL_init_crypto(OPENSSL_INIT_ENGINE_OPENSSL, NULL)
#define ENGINE_load_dynamic() \
    OPENSSL_init_crypto(OPENSSL_INIT_ENGINE_DYNAMIC, NULL)
#ifndef OPENSSL_NO_STATIC_ENGINE
#define ENGINE_load_padlock() \
    OPENSSL_init_crypto(OPENSSL_INIT_ENGINE_PADLOCK, NULL)
#define ENGINE_load_capi() \
    OPENSSL_init_crypto(OPENSSL_INIT_ENGINE_CAPI, NULL)
#define ENGINE_load_afalg() \
    OPENSSL_init_crypto(OPENSSL_INIT_ENGINE_AFALG, NULL)
#endif
#define ENGINE_load_cryptodev() \
    OPENSSL_init_crypto(OPENSSL_INIT_ENGINE_CRYPTODEV, NULL)
#define ENGINE_load_rdrand() \
    OPENSSL_init_crypto(OPENSSL_INIT_ENGINE_RDRAND, NULL)
#endif
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 void ENGINE_load_builtin_engines(void);
#endif

/*
 * Get and set global flags (ENGINE_TABLE_FLAG_***) for the implementation
 * "registry" handling.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 unsigned int ENGINE_get_table_flags(void);
OSSL_DEPRECATEDIN_3_0 void ENGINE_set_table_flags(unsigned int flags);
#endif

/*- Manage registration of ENGINEs per "table". For each type, there are 3
 * functions;
 *   ENGINE_register_***(e) - registers the implementation from 'e' (if it has one)
 *   ENGINE_unregister_***(e) - unregister the implementation from 'e'
 *   ENGINE_register_all_***() - call ENGINE_register_***() for each 'e' in the list
 * Cleanup is automatically registered from each table when required.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_RSA(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_RSA(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_RSA(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_DSA(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_DSA(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_DSA(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_EC(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_EC(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_EC(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_DH(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_DH(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_DH(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_RAND(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_RAND(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_RAND(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_ciphers(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_ciphers(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_ciphers(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_digests(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_digests(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_digests(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_pkey_meths(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_pkey_meths(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_pkey_meths(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_pkey_asn1_meths(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_unregister_pkey_asn1_meths(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 void ENGINE_register_all_pkey_asn1_meths(void);
#endif

/*
 * These functions register all support from the above categories. Note, use
 * of these functions can result in static linkage of code your application
 * may not need. If you only need a subset of functionality, consider using
 * more selective initialisation.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_complete(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_register_all_complete(void);
#endif

/*
 * Send parameterised control commands to the engine. The possibilities to
 * send down an integer, a pointer to data or a function pointer are
 * provided. Any of the parameters may or may not be NULL, depending on the
 * command number. In actuality, this function only requires a structural
 * (rather than functional) reference to an engine, but many control commands
 * may require the engine be functional. The caller should be aware of trying
 * commands that require an operational ENGINE, and only use functional
 * references in such situations.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_ctrl(ENGINE *e, int cmd, long i, void *p,
    void (*f)(void));
#endif

/*
 * This function tests if an ENGINE-specific command is usable as a
 * "setting". Eg. in an application's config file that gets processed through
 * ENGINE_ctrl_cmd_string(). If this returns zero, it is not available to
 * ENGINE_ctrl_cmd_string(), only ENGINE_ctrl().
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_cmd_is_executable(ENGINE *e, int cmd);
#endif

/*
 * This function works like ENGINE_ctrl() with the exception of taking a
 * command name instead of a command number, and can handle optional
 * commands. See the comment on ENGINE_ctrl_cmd_string() for an explanation
 * on how to use the cmd_name and cmd_optional.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_ctrl_cmd(ENGINE *e, const char *cmd_name,
    long i, void *p, void (*f)(void),
    int cmd_optional);
#endif

/*
 * This function passes a command-name and argument to an ENGINE. The
 * cmd_name is converted to a command number and the control command is
 * called using 'arg' as an argument (unless the ENGINE doesn't support such
 * a command, in which case no control command is called). The command is
 * checked for input flags, and if necessary the argument will be converted
 * to a numeric value. If cmd_optional is non-zero, then if the ENGINE
 * doesn't support the given cmd_name the return value will be success
 * anyway. This function is intended for applications to use so that users
 * (or config files) can supply engine-specific config data to the ENGINE at
 * run-time to control behaviour of specific engines. As such, it shouldn't
 * be used for calling ENGINE_ctrl() functions that return data, deal with
 * binary data, or that are otherwise supposed to be used directly through
 * ENGINE_ctrl() in application code. Any "return" data from an ENGINE_ctrl()
 * operation in this function will be lost - the return value is interpreted
 * as failure if the return value is zero, success otherwise, and this
 * function returns a boolean value as a result. In other words, vendors of
 * 'ENGINE'-enabled devices should write ENGINE implementations with
 * parameterisations that work in this scheme, so that compliant ENGINE-based
 * applications can work consistently with the same configuration for the
 * same ENGINE-enabled devices, across applications.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
int ENGINE_ctrl_cmd_string(ENGINE *e, const char *cmd_name, const char *arg,
    int cmd_optional);
#endif

/*
 * These functions are useful for manufacturing new ENGINE structures. They
 * don't address reference counting at all - one uses them to populate an
 * ENGINE structure with personalised implementations of things prior to
 * using it directly or adding it to the builtin ENGINE list in OpenSSL.
 * These are also here so that the ENGINE structure doesn't have to be
 * exposed and break binary compatibility!
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_new(void);
OSSL_DEPRECATEDIN_3_0 int ENGINE_free(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_up_ref(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_id(ENGINE *e, const char *id);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_name(ENGINE *e, const char *name);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_RSA(ENGINE *e, const RSA_METHOD *rsa_meth);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_DSA(ENGINE *e, const DSA_METHOD *dsa_meth);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_EC(ENGINE *e, const EC_KEY_METHOD *ecdsa_meth);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_DH(ENGINE *e, const DH_METHOD *dh_meth);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_RAND(ENGINE *e, const RAND_METHOD *rand_meth);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_destroy_function(ENGINE *e, ENGINE_GEN_INT_FUNC_PTR destroy_f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_init_function(ENGINE *e, ENGINE_GEN_INT_FUNC_PTR init_f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_finish_function(ENGINE *e, ENGINE_GEN_INT_FUNC_PTR finish_f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_ctrl_function(ENGINE *e, ENGINE_CTRL_FUNC_PTR ctrl_f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_load_privkey_function(ENGINE *e, ENGINE_LOAD_KEY_PTR loadpriv_f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_load_pubkey_function(ENGINE *e, ENGINE_LOAD_KEY_PTR loadpub_f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_load_ssl_client_cert_function(ENGINE *e,
    ENGINE_SSL_CLIENT_CERT_PTR loadssl_f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_ciphers(ENGINE *e, ENGINE_CIPHERS_PTR f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_digests(ENGINE *e, ENGINE_DIGESTS_PTR f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_pkey_meths(ENGINE *e, ENGINE_PKEY_METHS_PTR f);
OSSL_DEPRECATEDIN_3_0
int ENGINE_set_pkey_asn1_meths(ENGINE *e, ENGINE_PKEY_ASN1_METHS_PTR f);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_flags(ENGINE *e, int flags);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_cmd_defns(ENGINE *e,
    const ENGINE_CMD_DEFN *defns);
#endif
/* These functions allow control over any per-structure ENGINE data. */
#define ENGINE_get_ex_new_index(l, p, newf, dupf, freef) \
    CRYPTO_get_ex_new_index(CRYPTO_EX_INDEX_ENGINE, l, p, newf, dupf, freef)
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_ex_data(ENGINE *e, int idx, void *arg);
OSSL_DEPRECATEDIN_3_0 void *ENGINE_get_ex_data(const ENGINE *e, int idx);
#endif

#ifndef OPENSSL_NO_DEPRECATED_1_1_0
/*
 * This function previously cleaned up anything that needs it. Auto-deinit will
 * now take care of it so it is no longer required to call this function.
 */
#define ENGINE_cleanup() \
    while (0)            \
    continue
#endif

/*
 * These return values from within the ENGINE structure. These can be useful
 * with functional references as well as structural references - it depends
 * which you obtained. Using the result for functional purposes if you only
 * obtained a structural reference may be problematic!
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 const char *ENGINE_get_id(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0 const char *ENGINE_get_name(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0 const RSA_METHOD *ENGINE_get_RSA(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0 const DSA_METHOD *ENGINE_get_DSA(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0 const EC_KEY_METHOD *ENGINE_get_EC(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0 const DH_METHOD *ENGINE_get_DH(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0 const RAND_METHOD *ENGINE_get_RAND(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_GEN_INT_FUNC_PTR ENGINE_get_destroy_function(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_GEN_INT_FUNC_PTR ENGINE_get_init_function(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_GEN_INT_FUNC_PTR ENGINE_get_finish_function(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_CTRL_FUNC_PTR ENGINE_get_ctrl_function(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_LOAD_KEY_PTR ENGINE_get_load_privkey_function(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_LOAD_KEY_PTR ENGINE_get_load_pubkey_function(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_SSL_CLIENT_CERT_PTR ENGINE_get_ssl_client_cert_function(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_CIPHERS_PTR ENGINE_get_ciphers(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_DIGESTS_PTR ENGINE_get_digests(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_PKEY_METHS_PTR ENGINE_get_pkey_meths(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
ENGINE_PKEY_ASN1_METHS_PTR ENGINE_get_pkey_asn1_meths(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0
const EVP_CIPHER *ENGINE_get_cipher(ENGINE *e, int nid);
OSSL_DEPRECATEDIN_3_0
const EVP_MD *ENGINE_get_digest(ENGINE *e, int nid);
OSSL_DEPRECATEDIN_3_0
const EVP_PKEY_METHOD *ENGINE_get_pkey_meth(ENGINE *e, int nid);
OSSL_DEPRECATEDIN_3_0
const EVP_PKEY_ASN1_METHOD *ENGINE_get_pkey_asn1_meth(ENGINE *e, int nid);
OSSL_DEPRECATEDIN_3_0
const EVP_PKEY_ASN1_METHOD *ENGINE_get_pkey_asn1_meth_str(ENGINE *e,
    const char *str,
    int len);
OSSL_DEPRECATEDIN_3_0
const EVP_PKEY_ASN1_METHOD *ENGINE_pkey_asn1_find_str(ENGINE **pe,
    const char *str, int len);
OSSL_DEPRECATEDIN_3_0
const ENGINE_CMD_DEFN *ENGINE_get_cmd_defns(const ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_get_flags(const ENGINE *e);
#endif

/*
 * FUNCTIONAL functions. These functions deal with ENGINE structures that
 * have (or will) be initialised for use. Broadly speaking, the structural
 * functions are useful for iterating the list of available engine types,
 * creating new engine types, and other "list" operations. These functions
 * actually deal with ENGINEs that are to be used. As such these functions
 * can fail (if applicable) when particular engines are unavailable - eg. if
 * a hardware accelerator is not attached or not functioning correctly. Each
 * ENGINE has 2 reference counts; structural and functional. Every time a
 * functional reference is obtained or released, a corresponding structural
 * reference is automatically obtained or released too.
 */

/*
 * Initialise an engine type for use (or up its reference count if it's
 * already in use). This will fail if the engine is not currently operational
 * and cannot initialise.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_init(ENGINE *e);
#endif
/*
 * Free a functional reference to an engine type. This does not require a
 * corresponding call to ENGINE_free as it also releases a structural
 * reference.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_finish(ENGINE *e);
#endif

/*
 * The following functions handle keys that are stored in some secondary
 * location, handled by the engine.  The storage may be on a card or
 * whatever.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0
EVP_PKEY *ENGINE_load_private_key(ENGINE *e, const char *key_id,
    UI_METHOD *ui_method, void *callback_data);
OSSL_DEPRECATEDIN_3_0
EVP_PKEY *ENGINE_load_public_key(ENGINE *e, const char *key_id,
    UI_METHOD *ui_method, void *callback_data);
OSSL_DEPRECATEDIN_3_0
int ENGINE_load_ssl_client_cert(ENGINE *e, SSL *s, STACK_OF(X509_NAME) *ca_dn,
    X509 **pcert, EVP_PKEY **ppkey,
    STACK_OF(X509) **pother,
    UI_METHOD *ui_method, void *callback_data);
#endif

/*
 * This returns a pointer for the current ENGINE structure that is (by
 * default) performing any RSA operations. The value returned is an
 * incremented reference, so it should be free'd (ENGINE_finish) before it is
 * discarded.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_default_RSA(void);
#endif
/* Same for the other "methods" */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_default_DSA(void);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_default_EC(void);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_default_DH(void);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_default_RAND(void);
#endif
/*
 * These functions can be used to get a functional reference to perform
 * ciphering or digesting corresponding to "nid".
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_cipher_engine(int nid);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_digest_engine(int nid);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_pkey_meth_engine(int nid);
OSSL_DEPRECATEDIN_3_0 ENGINE *ENGINE_get_pkey_asn1_meth_engine(int nid);
#endif

/*
 * This sets a new default ENGINE structure for performing RSA operations. If
 * the result is non-zero (success) then the ENGINE structure will have had
 * its reference count up'd so the caller should still free their own
 * reference 'e'.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_RSA(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_string(ENGINE *e,
    const char *def_list);
#endif
/* Same for the other "methods" */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_DSA(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_EC(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_DH(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_RAND(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_ciphers(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_digests(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_pkey_meths(ENGINE *e);
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default_pkey_asn1_meths(ENGINE *e);
#endif

/*
 * The combination "set" - the flags are bitwise "OR"d from the
 * ENGINE_METHOD_*** defines above. As with the "ENGINE_register_complete()"
 * function, this function can result in unnecessary static linkage. If your
 * application requires only specific functionality, consider using more
 * selective functions.
 */
#ifndef OPENSSL_NO_DEPRECATED_3_0
OSSL_DEPRECATEDIN_3_0 int ENGINE_set_default(ENGINE *e, unsigned int flags);
OSSL_DEPRECATEDIN_3_0 void ENGINE_add_conf_module(void);
#endif

/* Deprecated functions ... */
/* int ENGINE_clear_defaults(void); */

/**************************/
/* DYNAMIC ENGINE SUPPORT */
/**************************/

/* Binary/behaviour compatibility levels */
#define OSSL_DYNAMIC_VERSION (unsigned long)0x00030000
/*
 * Binary versions older than this are too old for us (whether we're a loader
 * or a loadee)
 */
#define OSSL_DYNAMIC_OLDEST (unsigned long)0x00030000

/*
 * When compiling an ENGINE entirely as an external shared library, loadable
 * by the "dynamic" ENGINE, these types are needed. The 'dynamic_fns'
 * structure type provides the calling application's (or library's) error
 * functionality and memory management function pointers to the loaded
 * library. These should be used/set in the loaded library code so that the
 * loading application's 'state' will be used/changed in all operations. The
 * 'static_state' pointer allows the loaded library to know if it shares the
 * same static data as the calling application (or library), and thus whether
 * these callbacks need to be set or not.
 */
typedef void *(*dyn_MEM_malloc_fn)(size_t, const char *, int);
typedef void *(*dyn_MEM_realloc_fn)(void *, size_t, const char *, int);
typedef void (*dyn_MEM_free_fn)(void *, const char *, int);
typedef struct st_dynamic_MEM_fns {
    dyn_MEM_malloc_fn malloc_fn;
    dyn_MEM_realloc_fn realloc_fn;
    dyn_MEM_free_fn free_fn;
} dynamic_MEM_fns;
/*
 * FIXME: Perhaps the memory and locking code (crypto.h) should declare and
 * use these types so we (and any other dependent code) can simplify a bit??
 */
/* The top-level structure */
typedef struct st_dynamic_fns {
    void *static_state;
    dynamic_MEM_fns mem_fns;
} dynamic_fns;

/*
 * The version checking function should be of this prototype. NB: The
 * ossl_version value passed in is the OSSL_DYNAMIC_VERSION of the loading
 * code. If this function returns zero, it indicates a (potential) version
 * incompatibility and the loaded library doesn't believe it can proceed.
 * Otherwise, the returned value is the (latest) version supported by the
 * loading library. The loader may still decide that the loaded code's
 * version is unsatisfactory and could veto the load. The function is
 * expected to be implemented with the symbol name "v_check", and a default
 * implementation can be fully instantiated with
 * IMPLEMENT_DYNAMIC_CHECK_FN().
 */
typedef unsigned long (*dynamic_v_check_fn)(unsigned long ossl_version);
#define IMPLEMENT_DYNAMIC_CHECK_FN()                       \
    OPENSSL_EXPORT unsigned long v_check(unsigned long v); \
    OPENSSL_EXPORT unsigned long v_check(unsigned long v)  \
    {                                                      \
        if (v >= OSSL_DYNAMIC_OLDEST)                      \
            return OSSL_DYNAMIC_VERSION;                   \
        return 0;                                          \
    }

/*
 * This function is passed the ENGINE structure to initialise with its own
 * function and command settings. It should not adjust the structural or
 * functional reference counts. If this function returns zero, (a) the load
 * will be aborted, (b) the previous ENGINE state will be memcpy'd back onto
 * the structure, and (c) the shared library will be unloaded. So
 * implementations should do their own internal cleanup in failure
 * circumstances otherwise they could leak. The 'id' parameter, if non-NULL,
 * represents the ENGINE id that the loader is looking for. If this is NULL,
 * the shared library can choose to return failure or to initialise a
 * 'default' ENGINE. If non-NULL, the shared library must initialise only an
 * ENGINE matching the passed 'id'. The function is expected to be
 * implemented with the symbol name "bind_engine". A standard implementation
 * can be instantiated with IMPLEMENT_DYNAMIC_BIND_FN(fn) where the parameter
 * 'fn' is a callback function that populates the ENGINE structure and
 * returns an int value (zero for failure). 'fn' should have prototype;
 * [static] int fn(ENGINE *e, const char *id);
 */
typedef int (*dynamic_bind_engine)(ENGINE *e, const char *id,
    const dynamic_fns *fns);
#define IMPLEMENT_DYNAMIC_BIND_FN(fn)                                   \
    OPENSSL_EXPORT                                                      \
    int bind_engine(ENGINE *e, const char *id, const dynamic_fns *fns); \
    OPENSSL_EXPORT                                                      \
    int bind_engine(ENGINE *e, const char *id, const dynamic_fns *fns)  \
    {                                                                   \
        if (ENGINE_get_static_state() == fns->static_state)             \
            goto skip_cbs;                                              \
        CRYPTO_set_mem_functions(fns->mem_fns.malloc_fn,                \
            fns->mem_fns.realloc_fn,                                    \
            fns->mem_fns.free_fn);                                      \
        OPENSSL_init_crypto(OPENSSL_INIT_NO_ATEXIT, NULL);              \
    skip_cbs:                                                           \
        if (!fn(e, id))                                                 \
            return 0;                                                   \
        return 1;                                                       \
    }

/*
 * If the loading application (or library) and the loaded ENGINE library
 * share the same static data (eg. they're both dynamically linked to the
 * same libcrypto.so) we need a way to avoid trying to set system callbacks -
 * this would fail, and for the same reason that it's unnecessary to try. If
 * the loaded ENGINE has (or gets from through the loader) its own copy of
 * the libcrypto static data, we will need to set the callbacks. The easiest
 * way to detect this is to have a function that returns a pointer to some
 * static data and let the loading application and loaded ENGINE compare
 * their respective values.
 */
void *ENGINE_get_static_state(void);

#if defined(__OpenBSD__) || defined(__FreeBSD__) || defined(__DragonFly__)
#ifndef OPENSSL_NO_DEPRECATED_1_1_0
OSSL_DEPRECATEDIN_1_1_0 void ENGINE_setup_bsd_cryptodev(void);
#endif
#endif

#ifdef __cplusplus
}
#endif
#endif /* OPENSSL_NO_ENGINE */
#endif /* OPENSSL_ENGINE_H */
