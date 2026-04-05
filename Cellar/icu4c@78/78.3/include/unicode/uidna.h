// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 *
 *   Copyright (C) 2003-2014, International Business Machines
 *   Corporation and others.  All Rights Reserved.
 *
 *******************************************************************************
 *   file name:  uidna.h
 *   encoding:   UTF-8
 *   tab size:   8 (not used)
 *   indentation:4
 *
 *   created on: 2003feb1
 *   created by: Ram Viswanadha
 */

#ifndef __UIDNA_H__
#define __UIDNA_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_IDNA

#include <stdbool.h>
#include "unicode/parseerr.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: Internationalizing Domain Names in Applications (IDNA)
 *
 * IDNA2008 is implemented according to UTS #46, see the IDNA C++ class in idna.h.
 *
 * The C API functions which do take a UIDNA * service object pointer
 * implement UTS #46 and IDNA2008.
 *
 * IDNA2003 is obsolete.
 * The C API functions which do not take a service object pointer
 * implement IDNA2003. They are all deprecated.
 */

/*
 * IDNA option bit set values.
 */
enum {
    /**
     * Default options value: UTS #46 nontransitional processing.
     * For use in static worker and factory methods.
     *
     * Since ICU 76, this is the same as
     * UIDNA_NONTRANSITIONAL_TO_ASCII | UIDNA_NONTRANSITIONAL_TO_UNICODE,
     * corresponding to Unicode 15.1 UTS #46 deprecating transitional processing.
     * (These options are ignored by the IDNA2003 implementation.)
     *
     * Before ICU 76, this constant did not set any of the options.
     *
     * @stable ICU 2.6
     */
    UIDNA_DEFAULT=0x30,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * Option to allow unassigned code points in domain names and labels.
     * For use in static worker and factory methods.
     * <p>This option is ignored by the UTS46 implementation.
     * (UTS #46 disallows unassigned code points.)
     * @deprecated ICU 55 Use UTS #46 instead via uidna_openUTS46() or class IDNA.
     */
    UIDNA_ALLOW_UNASSIGNED=1,
#endif  /* U_HIDE_DEPRECATED_API */
    /**
     * Option to check whether the input conforms to the STD3 ASCII rules,
     * for example the restriction of labels to LDH characters
     * (ASCII Letters, Digits and Hyphen-Minus).
     * For use in static worker and factory methods.
     * @stable ICU 2.6
     */
    UIDNA_USE_STD3_RULES=2,
    /**
     * IDNA option to check for whether the input conforms to the BiDi rules.
     * For use in static worker and factory methods.
     * <p>This option is ignored by the IDNA2003 implementation.
     * (IDNA2003 always performs a BiDi check.)
     * @stable ICU 4.6
     */
    UIDNA_CHECK_BIDI=4,
    /**
     * IDNA option to check for whether the input conforms to the CONTEXTJ rules.
     * For use in static worker and factory methods.
     * <p>This option is ignored by the IDNA2003 implementation.
     * (The CONTEXTJ check is new in IDNA2008.)
     * @stable ICU 4.6
     */
    UIDNA_CHECK_CONTEXTJ=8,
    /**
     * IDNA option for nontransitional processing in ToASCII().
     * For use in static worker and factory methods.
     *
     * <p>By default, ToASCII() uses transitional processing.
     * Unicode 15.1 UTS #46 deprecated transitional processing.
     *
     * <p>This option is ignored by the IDNA2003 implementation.
     * (This is only relevant for compatibility of newer IDNA implementations with IDNA2003.)
     * @stable ICU 4.6
     * @see UIDNA_DEFAULT
     */
    UIDNA_NONTRANSITIONAL_TO_ASCII=0x10,
    /**
     * IDNA option for nontransitional processing in ToUnicode().
     * For use in static worker and factory methods.
     *
     * <p>By default, ToUnicode() uses transitional processing.
     * Unicode 15.1 UTS #46 deprecated transitional processing.
     *
     * <p>This option is ignored by the IDNA2003 implementation.
     * (This is only relevant for compatibility of newer IDNA implementations with IDNA2003.)
     * @stable ICU 4.6
     * @see UIDNA_DEFAULT
     */
    UIDNA_NONTRANSITIONAL_TO_UNICODE=0x20,
    /**
     * IDNA option to check for whether the input conforms to the CONTEXTO rules.
     * For use in static worker and factory methods.
     * <p>This option is ignored by the IDNA2003 implementation.
     * (The CONTEXTO check is new in IDNA2008.)
     * <p>This is for use by registries for IDNA2008 conformance.
     * UTS #46 does not require the CONTEXTO check.
     * @stable ICU 49
     */
    UIDNA_CHECK_CONTEXTO=0x40
};

/**
 * Opaque C service object type for the new IDNA API.
 * @stable ICU 4.6
 */
struct UIDNA;
typedef struct UIDNA UIDNA;  /**< C typedef for struct UIDNA. @stable ICU 4.6 */

/**
 * Returns a UIDNA instance which implements UTS #46.
 * Returns an unmodifiable instance, owned by the caller.
 * Cache it for multiple operations, and uidna_close() it when done.
 * The instance is thread-safe, that is, it can be used concurrently.
 *
 * For details about the UTS #46 implementation see the IDNA C++ class in idna.h.
 *
 * @param options Bit set to modify the processing and error checking.
 *                These should include UIDNA_DEFAULT, or
 *                UIDNA_NONTRANSITIONAL_TO_ASCII | UIDNA_NONTRANSITIONAL_TO_UNICODE.
 *                See option bit set values in uidna.h.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return the UTS #46 UIDNA instance, if successful
 * @stable ICU 4.6
 */
U_CAPI UIDNA * U_EXPORT2
uidna_openUTS46(uint32_t options, UErrorCode *pErrorCode);

/**
 * Closes a UIDNA instance.
 * @param idna UIDNA instance to be closed
 * @stable ICU 4.6
 */
U_CAPI void U_EXPORT2
uidna_close(UIDNA *idna);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUIDNAPointer
 * "Smart pointer" class, closes a UIDNA via uidna_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.6
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUIDNAPointer, UIDNA, uidna_close);

U_NAMESPACE_END

#endif

/**
 * Output container for IDNA processing errors.
 * Initialize with UIDNA_INFO_INITIALIZER:
 * \code
 * UIDNAInfo info = UIDNA_INFO_INITIALIZER;
 * int32_t length = uidna_nameToASCII(..., &info, &errorCode);
 * if(U_SUCCESS(errorCode) && info.errors!=0) { ... }
 * \endcode
 * @stable ICU 4.6
 */
typedef struct UIDNAInfo {
    /** sizeof(UIDNAInfo) @stable ICU 4.6 */
    int16_t size;
    /**
     * Set to true if transitional and nontransitional processing produce different results.
     * For details see C++ IDNAInfo::isTransitionalDifferent().
     * @stable ICU 4.6
     */
    UBool isTransitionalDifferent;
    UBool reservedB3;  /**< Reserved field, do not use. @internal */
    /**
     * Bit set indicating IDNA processing errors. 0 if no errors.
     * See UIDNA_ERROR_... constants.
     * @stable ICU 4.6
     */
    uint32_t errors;
    int32_t reservedI2;  /**< Reserved field, do not use. @internal */
    int32_t reservedI3;  /**< Reserved field, do not use. @internal */
} UIDNAInfo;

/**
 * Static initializer for a UIDNAInfo struct.
 * @stable ICU 4.6
 */
#define UIDNA_INFO_INITIALIZER { \
    (int16_t)sizeof(UIDNAInfo), \
    false, false, \
    0, 0, 0 }

/**
 * Converts a single domain name label into its ASCII form for DNS lookup.
 * If any processing step fails, then pInfo->errors will be non-zero and
 * the result might not be an ASCII string.
 * The label might be modified according to the types of errors.
 * Labels with severe errors will be left in (or turned into) their Unicode form.
 *
 * The UErrorCode indicates an error only in exceptional cases,
 * such as a U_MEMORY_ALLOCATION_ERROR.
 *
 * @param idna UIDNA instance
 * @param label Input domain name label
 * @param length Label length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_labelToASCII(const UIDNA *idna,
                   const UChar *label, int32_t length,
                   UChar *dest, int32_t capacity,
                   UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/**
 * Converts a single domain name label into its Unicode form for human-readable display.
 * If any processing step fails, then pInfo->errors will be non-zero.
 * The label might be modified according to the types of errors.
 *
 * The UErrorCode indicates an error only in exceptional cases,
 * such as a U_MEMORY_ALLOCATION_ERROR.
 *
 * @param idna UIDNA instance
 * @param label Input domain name label
 * @param length Label length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_labelToUnicode(const UIDNA *idna,
                     const UChar *label, int32_t length,
                     UChar *dest, int32_t capacity,
                     UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/**
 * Converts a whole domain name into its ASCII form for DNS lookup.
 * If any processing step fails, then pInfo->errors will be non-zero and
 * the result might not be an ASCII string.
 * The domain name might be modified according to the types of errors.
 * Labels with severe errors will be left in (or turned into) their Unicode form.
 *
 * The UErrorCode indicates an error only in exceptional cases,
 * such as a U_MEMORY_ALLOCATION_ERROR.
 *
 * @param idna UIDNA instance
 * @param name Input domain name
 * @param length Domain name length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_nameToASCII(const UIDNA *idna,
                  const UChar *name, int32_t length,
                  UChar *dest, int32_t capacity,
                  UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/**
 * Converts a whole domain name into its Unicode form for human-readable display.
 * If any processing step fails, then pInfo->errors will be non-zero.
 * The domain name might be modified according to the types of errors.
 *
 * The UErrorCode indicates an error only in exceptional cases,
 * such as a U_MEMORY_ALLOCATION_ERROR.
 *
 * @param idna UIDNA instance
 * @param name Input domain name
 * @param length Domain name length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_nameToUnicode(const UIDNA *idna,
                    const UChar *name, int32_t length,
                    UChar *dest, int32_t capacity,
                    UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/* UTF-8 versions of the processing methods --------------------------------- */

/**
 * Converts a single domain name label into its ASCII form for DNS lookup.
 * UTF-8 version of uidna_labelToASCII(), same behavior.
 *
 * @param idna UIDNA instance
 * @param label Input domain name label
 * @param length Label length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_labelToASCII_UTF8(const UIDNA *idna,
                        const char *label, int32_t length,
                        char *dest, int32_t capacity,
                        UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/**
 * Converts a single domain name label into its Unicode form for human-readable display.
 * UTF-8 version of uidna_labelToUnicode(), same behavior.
 *
 * @param idna UIDNA instance
 * @param label Input domain name label
 * @param length Label length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_labelToUnicodeUTF8(const UIDNA *idna,
                         const char *label, int32_t length,
                         char *dest, int32_t capacity,
                         UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/**
 * Converts a whole domain name into its ASCII form for DNS lookup.
 * UTF-8 version of uidna_nameToASCII(), same behavior.
 *
 * @param idna UIDNA instance
 * @param name Input domain name
 * @param length Domain name length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_nameToASCII_UTF8(const UIDNA *idna,
                       const char *name, int32_t length,
                       char *dest, int32_t capacity,
                       UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/**
 * Converts a whole domain name into its Unicode form for human-readable display.
 * UTF-8 version of uidna_nameToUnicode(), same behavior.
 *
 * @param idna UIDNA instance
 * @param name Input domain name
 * @param length Domain name length, or -1 if NUL-terminated
 * @param dest Destination string buffer
 * @param capacity Destination buffer capacity
 * @param pInfo Output container of IDNA processing details.
 * @param pErrorCode Standard ICU error code. Its input value must
 *                  pass the U_SUCCESS() test, or else the function returns
 *                  immediately. Check for U_FAILURE() on output or use with
 *                  function chaining. (See User Guide for details.)
 * @return destination string length
 * @stable ICU 4.6
 */
U_CAPI int32_t U_EXPORT2
uidna_nameToUnicodeUTF8(const UIDNA *idna,
                        const char *name, int32_t length,
                        char *dest, int32_t capacity,
                        UIDNAInfo *pInfo, UErrorCode *pErrorCode);

/*
 * IDNA error bit set values.
 * When a domain name or label fails a processing step or does not meet the
 * validity criteria, then one or more of these error bits are set.
 */
enum {
    /**
     * A non-final domain name label (or the whole domain name) is empty.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_EMPTY_LABEL=1,
    /**
     * A domain name label is longer than 63 bytes.
     * (See STD13/RFC1034 3.1. Name space specifications and terminology.)
     * This is only checked in ToASCII operations, and only if the output label is all-ASCII.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_LABEL_TOO_LONG=2,
    /**
     * A domain name is longer than 255 bytes in its storage form.
     * (See STD13/RFC1034 3.1. Name space specifications and terminology.)
     * This is only checked in ToASCII operations, and only if the output domain name is all-ASCII.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_DOMAIN_NAME_TOO_LONG=4,
    /**
     * A label starts with a hyphen-minus ('-').
     * @stable ICU 4.6
     */
    UIDNA_ERROR_LEADING_HYPHEN=8,
    /**
     * A label ends with a hyphen-minus ('-').
     * @stable ICU 4.6
     */
    UIDNA_ERROR_TRAILING_HYPHEN=0x10,
    /**
     * A label contains hyphen-minus ('-') in the third and fourth positions.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_HYPHEN_3_4=0x20,
    /**
     * A label starts with a combining mark.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_LEADING_COMBINING_MARK=0x40,
    /**
     * A label or domain name contains disallowed characters.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_DISALLOWED=0x80,
    /**
     * A label starts with "xn--" but does not contain valid Punycode.
     * That is, an xn-- label failed Punycode decoding.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_PUNYCODE=0x100,
    /**
     * A label contains a dot=full stop.
     * This can occur in an input string for a single-label function.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_LABEL_HAS_DOT=0x200,
    /**
     * An ACE label does not contain a valid label string.
     * The label was successfully ACE (Punycode) decoded but the resulting
     * string had severe validation errors. For example,
     * it might contain characters that are not allowed in ACE labels,
     * or it might not be normalized.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_INVALID_ACE_LABEL=0x400,
    /**
     * A label does not meet the IDNA BiDi requirements (for right-to-left characters).
     * @stable ICU 4.6
     */
    UIDNA_ERROR_BIDI=0x800,
    /**
     * A label does not meet the IDNA CONTEXTJ requirements.
     * @stable ICU 4.6
     */
    UIDNA_ERROR_CONTEXTJ=0x1000,
    /**
     * A label does not meet the IDNA CONTEXTO requirements for punctuation characters.
     * Some punctuation characters "Would otherwise have been DISALLOWED"
     * but are allowed in certain contexts. (RFC 5892)
     * @stable ICU 49
     */
    UIDNA_ERROR_CONTEXTO_PUNCTUATION=0x2000,
    /**
     * A label does not meet the IDNA CONTEXTO requirements for digits.
     * Arabic-Indic Digits (U+066x) must not be mixed with Extended Arabic-Indic Digits (U+06Fx).
     * @stable ICU 49
     */
    UIDNA_ERROR_CONTEXTO_DIGITS=0x4000
};

#ifndef U_HIDE_DEPRECATED_API

/* IDNA2003 API ------------------------------------------------------------- */

/**
 * IDNA2003: This function implements the ToASCII operation as defined in the IDNA RFC.
 * This operation is done on <b>single labels</b> before sending it to something that expects
 * ASCII names. A label is an individual part of a domain name. Labels are usually
 * separated by dots; e.g. "www.example.com" is composed of 3 labels "www","example", and "com".
 *
 * IDNA2003 API Overview:
 *
 * The uidna_ API implements the IDNA protocol as defined in the IDNA RFC
 * (http://www.ietf.org/rfc/rfc3490.txt).
 * The RFC defines 2 operations: ToASCII and ToUnicode. Domain name labels
 * containing non-ASCII code points are processed by the
 * ToASCII operation before passing it to resolver libraries. Domain names
 * that are obtained from resolver libraries are processed by the
 * ToUnicode operation before displaying the domain name to the user.
 * IDNA requires that implementations process input strings with Nameprep
 * (http://www.ietf.org/rfc/rfc3491.txt),
 * which is a profile of Stringprep (http://www.ietf.org/rfc/rfc3454.txt),
 * and then with Punycode (http://www.ietf.org/rfc/rfc3492.txt).
 * Implementations of IDNA MUST fully implement Nameprep and Punycode;
 * neither Nameprep nor Punycode are optional.
 * The input and output of ToASCII and ToUnicode operations are Unicode
 * and are designed to be chainable, i.e., applying ToASCII or ToUnicode operations
 * multiple times to an input string will yield the same result as applying the operation
 * once.
 * ToUnicode(ToUnicode(ToUnicode...(ToUnicode(string)))) == ToUnicode(string) 
 * ToASCII(ToASCII(ToASCII...(ToASCII(string))) == ToASCII(string).
 *
 * @param src               Input UChar array containing label in Unicode.
 * @param srcLength         Number of UChars in src, or -1 if NUL-terminated.
 * @param dest              Output UChar array with ASCII (ACE encoded) label.
 * @param destCapacity      Size of dest.
 * @param options           A bit set of options:
 *
 *  - UIDNA_DEFAULT             Use default options, i.e., do not process unassigned code points
 *                              and do not use STD3 ASCII rules
 *                              If unassigned code points are found the operation fails with 
 *                              U_UNASSIGNED_ERROR error code.
 *
 *  - UIDNA_ALLOW_UNASSIGNED    Unassigned values can be converted to ASCII for query operations
 *                              If this option is set, the unassigned code points are in the input 
 *                              are treated as normal Unicode code points.
 *
 *  - UIDNA_USE_STD3_RULES      Use STD3 ASCII rules for host name syntax restrictions
 *                              If this option is set and the input does not satisfy STD3 rules,  
 *                              the operation will fail with U_IDNA_STD3_ASCII_RULES_ERROR
 *
 * @param parseError        Pointer to UParseError struct to receive information on position 
 *                          of error if an error is encountered. Can be NULL.
 * @param status            ICU in/out error code parameter.
 *                          U_INVALID_CHAR_FOUND if src contains
 *                          unmatched single surrogates.
 *                          U_INDEX_OUTOFBOUNDS_ERROR if src contains
 *                          too many code points.
 *                          U_BUFFER_OVERFLOW_ERROR if destCapacity is not enough
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 * @deprecated ICU 55 Use UTS #46 instead via uidna_openUTS46() or class IDNA.
 */
U_DEPRECATED int32_t U_EXPORT2
uidna_toASCII(const UChar* src, int32_t srcLength, 
              UChar* dest, int32_t destCapacity,
              int32_t options,
              UParseError* parseError,
              UErrorCode* status);


/**
 * IDNA2003: This function implements the ToUnicode operation as defined in the IDNA RFC.
 * This operation is done on <b>single labels</b> before sending it to something that expects
 * Unicode names. A label is an individual part of a domain name. Labels are usually
 * separated by dots; for e.g. "www.example.com" is composed of 3 labels "www","example", and "com".
 *
 * @param src               Input UChar array containing ASCII (ACE encoded) label.
 * @param srcLength         Number of UChars in src, or -1 if NUL-terminated.
 * @param dest Output       Converted UChar array containing Unicode equivalent of label.
 * @param destCapacity      Size of dest.
 * @param options           A bit set of options:
 *
 *  - UIDNA_DEFAULT             Use default options, i.e., do not process unassigned code points
 *                              and do not use STD3 ASCII rules
 *                              If unassigned code points are found the operation fails with 
 *                              U_UNASSIGNED_ERROR error code.
 *
 *  - UIDNA_ALLOW_UNASSIGNED      Unassigned values can be converted to ASCII for query operations
 *                              If this option is set, the unassigned code points are in the input 
 *                              are treated as normal Unicode code points. <b> Note: </b> This option is 
 *                              required on toUnicode operation because the RFC mandates 
 *                              verification of decoded ACE input by applying toASCII and comparing
 *                              its output with source
 *
 *  - UIDNA_USE_STD3_RULES      Use STD3 ASCII rules for host name syntax restrictions
 *                              If this option is set and the input does not satisfy STD3 rules,  
 *                              the operation will fail with U_IDNA_STD3_ASCII_RULES_ERROR
 *
 * @param parseError        Pointer to UParseError struct to receive information on position 
 *                          of error if an error is encountered. Can be NULL.
 * @param status            ICU in/out error code parameter.
 *                          U_INVALID_CHAR_FOUND if src contains
 *                          unmatched single surrogates.
 *                          U_INDEX_OUTOFBOUNDS_ERROR if src contains
 *                          too many code points.
 *                          U_BUFFER_OVERFLOW_ERROR if destCapacity is not enough
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 * @deprecated ICU 55 Use UTS #46 instead via uidna_openUTS46() or class IDNA.
 */
U_DEPRECATED int32_t U_EXPORT2
uidna_toUnicode(const UChar* src, int32_t srcLength,
                UChar* dest, int32_t destCapacity,
                int32_t options,
                UParseError* parseError,
                UErrorCode* status);


/**
 * IDNA2003: Convenience function that implements the IDNToASCII operation as defined in the IDNA RFC.
 * This operation is done on complete domain names, e.g: "www.example.com". 
 * It is important to note that this operation can fail. If it fails, then the input 
 * domain name cannot be used as an Internationalized Domain Name and the application
 * should have methods defined to deal with the failure.
 *
 * <b>Note:</b> IDNA RFC specifies that a conformant application should divide a domain name
 * into separate labels, decide whether to apply allowUnassigned and useSTD3ASCIIRules on each, 
 * and then convert. This function does not offer that level of granularity. The options once  
 * set will apply to all labels in the domain name
 *
 * @param src               Input UChar array containing IDN in Unicode.
 * @param srcLength         Number of UChars in src, or -1 if NUL-terminated.
 * @param dest              Output UChar array with ASCII (ACE encoded) IDN.
 * @param destCapacity      Size of dest.
 * @param options           A bit set of options:
 *
 *  - UIDNA_DEFAULT             Use default options, i.e., do not process unassigned code points
 *                              and do not use STD3 ASCII rules
 *                              If unassigned code points are found the operation fails with 
 *                              U_UNASSIGNED_CODE_POINT_FOUND error code.
 *
 *  - UIDNA_ALLOW_UNASSIGNED    Unassigned values can be converted to ASCII for query operations
 *                              If this option is set, the unassigned code points are in the input 
 *                              are treated as normal Unicode code points.
 *
 *  - UIDNA_USE_STD3_RULES      Use STD3 ASCII rules for host name syntax restrictions
 *                              If this option is set and the input does not satisfy STD3 rules,  
 *                              the operation will fail with U_IDNA_STD3_ASCII_RULES_ERROR
 *
 * @param parseError        Pointer to UParseError struct to receive information on position 
 *                          of error if an error is encountered. Can be NULL.
 * @param status            ICU in/out error code parameter.
 *                          U_INVALID_CHAR_FOUND if src contains
 *                          unmatched single surrogates.
 *                          U_INDEX_OUTOFBOUNDS_ERROR if src contains
 *                          too many code points.
 *                          U_BUFFER_OVERFLOW_ERROR if destCapacity is not enough
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 * @deprecated ICU 55 Use UTS #46 instead via uidna_openUTS46() or class IDNA.
 */
U_DEPRECATED int32_t U_EXPORT2
uidna_IDNToASCII(  const UChar* src, int32_t srcLength,
                   UChar* dest, int32_t destCapacity,
                   int32_t options,
                   UParseError* parseError,
                   UErrorCode* status);

/**
 * IDNA2003: Convenience function that implements the IDNToUnicode operation as defined in the IDNA RFC.
 * This operation is done on complete domain names, e.g: "www.example.com". 
 *
 * <b>Note:</b> IDNA RFC specifies that a conformant application should divide a domain name
 * into separate labels, decide whether to apply allowUnassigned and useSTD3ASCIIRules on each, 
 * and then convert. This function does not offer that level of granularity. The options once  
 * set will apply to all labels in the domain name
 *
 * @param src               Input UChar array containing IDN in ASCII (ACE encoded) form.
 * @param srcLength         Number of UChars in src, or -1 if NUL-terminated.
 * @param dest Output       UChar array containing Unicode equivalent of source IDN.
 * @param destCapacity      Size of dest.
 * @param options           A bit set of options:
 *
 *  - UIDNA_DEFAULT             Use default options, i.e., do not process unassigned code points
 *                              and do not use STD3 ASCII rules
 *                              If unassigned code points are found the operation fails with 
 *                              U_UNASSIGNED_CODE_POINT_FOUND error code.
 *
 *  - UIDNA_ALLOW_UNASSIGNED    Unassigned values can be converted to ASCII for query operations
 *                              If this option is set, the unassigned code points are in the input 
 *                              are treated as normal Unicode code points.
 *
 *  - UIDNA_USE_STD3_RULES      Use STD3 ASCII rules for host name syntax restrictions
 *                              If this option is set and the input does not satisfy STD3 rules,  
 *                              the operation will fail with U_IDNA_STD3_ASCII_RULES_ERROR
 *
 * @param parseError        Pointer to UParseError struct to receive information on position 
 *                          of error if an error is encountered. Can be NULL.
 * @param status            ICU in/out error code parameter.
 *                          U_INVALID_CHAR_FOUND if src contains
 *                          unmatched single surrogates.
 *                          U_INDEX_OUTOFBOUNDS_ERROR if src contains
 *                          too many code points.
 *                          U_BUFFER_OVERFLOW_ERROR if destCapacity is not enough
 * @return The length of the result string, if successful - or in case of a buffer overflow,
 *         in which case it will be greater than destCapacity.
 * @deprecated ICU 55 Use UTS #46 instead via uidna_openUTS46() or class IDNA.
 */
U_DEPRECATED int32_t U_EXPORT2
uidna_IDNToUnicode(  const UChar* src, int32_t srcLength,
                     UChar* dest, int32_t destCapacity,
                     int32_t options,
                     UParseError* parseError,
                     UErrorCode* status);

/**
 * IDNA2003: Compare two IDN strings for equivalence.
 * This function splits the domain names into labels and compares them.
 * According to IDN RFC, whenever two labels are compared, they are 
 * considered equal if and only if their ASCII forms (obtained by 
 * applying toASCII) match using an case-insensitive ASCII comparison.
 * Two domain names are considered a match if and only if all labels 
 * match regardless of whether label separators match.
 *
 * @param s1                First source string.
 * @param length1           Length of first source string, or -1 if NUL-terminated.
 *
 * @param s2                Second source string.
 * @param length2           Length of second source string, or -1 if NUL-terminated.
 * @param options           A bit set of options:
 *
 *  - UIDNA_DEFAULT             Use default options, i.e., do not process unassigned code points
 *                              and do not use STD3 ASCII rules
 *                              If unassigned code points are found the operation fails with 
 *                              U_UNASSIGNED_CODE_POINT_FOUND error code.
 *
 *  - UIDNA_ALLOW_UNASSIGNED    Unassigned values can be converted to ASCII for query operations
 *                              If this option is set, the unassigned code points are in the input 
 *                              are treated as normal Unicode code points.
 *
 *  - UIDNA_USE_STD3_RULES      Use STD3 ASCII rules for host name syntax restrictions
 *                              If this option is set and the input does not satisfy STD3 rules,  
 *                              the operation will fail with U_IDNA_STD3_ASCII_RULES_ERROR
 *
 * @param status            ICU error code in/out parameter.
 *                          Must fulfill U_SUCCESS before the function call.
 * @return <0 or 0 or >0 as usual for string comparisons
 * @deprecated ICU 55 Use UTS #46 instead via uidna_openUTS46() or class IDNA.
 */
U_DEPRECATED int32_t U_EXPORT2
uidna_compare(  const UChar *s1, int32_t length1,
                const UChar *s2, int32_t length2,
                int32_t options,
                UErrorCode* status);

#endif  /* U_HIDE_DEPRECATED_API */

#endif /* #if !UCONFIG_NO_IDNA */

#endif
