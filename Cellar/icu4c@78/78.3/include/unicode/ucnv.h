// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 1999-2014, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
 *  ucnv.h:
 *  External APIs for the ICU's codeset conversion library
 *  Bertrand A. Damiba
 *
 * Modification History:
 *
 *   Date        Name        Description
 *   04/04/99    helena      Fixed internal header inclusion.
 *   05/11/00    helena      Added setFallback and usesFallback APIs.
 *   06/29/2000  helena      Major rewrite of the callback APIs.
 *   12/07/2000  srl         Update of documentation
 */

/**
 * \file
 * \brief C API: Character conversion
 *
 * <h2>Character Conversion C API</h2>
 *
 * <p>This API is used to convert codepage or character encoded data to and
 * from UTF-16. You can open a converter with {@link ucnv_open() }. With that
 * converter, you can get its properties, set options, convert your data and
 * close the converter.</p>
 *
 * <p>Since many software programs recognize different converter names for
 * different types of converters, there are other functions in this API to
 * iterate over the converter aliases. The functions {@link ucnv_getAvailableName() },
 * {@link ucnv_getAlias() } and {@link ucnv_getStandardName() } are some of the
 * more frequently used alias functions to get this information.</p>
 *
 * <p>When a converter encounters an illegal, irregular, invalid or unmappable character
 * its default behavior is to use a substitution character to replace the
 * bad byte sequence. This behavior can be changed by using {@link ucnv_setFromUCallBack() }
 * or {@link ucnv_setToUCallBack() } on the converter. The header ucnv_err.h defines
 * many other callback actions that can be used instead of a character substitution.</p>
 *
 * <p>More information about this API can be found in our
 * <a href="https://unicode-org.github.io/icu/userguide/conversion/">User Guide</a>.</p>
 */

#ifndef UCNV_H
#define UCNV_H

#include "unicode/ucnv_err.h"
#include "unicode/uenum.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

#if !defined(USET_DEFINED) && !defined(U_IN_DOXYGEN)

#define USET_DEFINED

/**
 * USet is the C API type corresponding to C++ class UnicodeSet.
 * It is forward-declared here to avoid including unicode/uset.h file if related
 * conversion APIs are not used.
 *
 * @see ucnv_getUnicodeSet
 * @stable ICU 2.4
 */
typedef struct USet USet;

#endif

#if !UCONFIG_NO_CONVERSION

U_CDECL_BEGIN

/** Maximum length of a converter name including the terminating NULL @stable ICU 2.0 */
#define UCNV_MAX_CONVERTER_NAME_LENGTH 60
/** Maximum length of a converter name including path and terminating NULL @stable ICU 2.0 */
#define UCNV_MAX_FULL_FILE_NAME_LENGTH (600+UCNV_MAX_CONVERTER_NAME_LENGTH)

/** Shift in for EBDCDIC_STATEFUL and iso2022 states @stable ICU 2.0 */
#define  UCNV_SI 0x0F
/** Shift out for EBDCDIC_STATEFUL and iso2022 states @stable ICU 2.0 */
#define  UCNV_SO 0x0E

/**
 * Enum for specifying basic types of converters
 * @see ucnv_getType
 * @stable ICU 2.0
 */
typedef enum {
    /** @stable ICU 2.0 */
    UCNV_UNSUPPORTED_CONVERTER = -1,
    /** @stable ICU 2.0 */
    UCNV_SBCS = 0,
    /** @stable ICU 2.0 */
    UCNV_DBCS = 1,
    /** @stable ICU 2.0 */
    UCNV_MBCS = 2,
    /** @stable ICU 2.0 */
    UCNV_LATIN_1 = 3,
    /** @stable ICU 2.0 */
    UCNV_UTF8 = 4,
    /** @stable ICU 2.0 */
    UCNV_UTF16_BigEndian = 5,
    /** @stable ICU 2.0 */
    UCNV_UTF16_LittleEndian = 6,
    /** @stable ICU 2.0 */
    UCNV_UTF32_BigEndian = 7,
    /** @stable ICU 2.0 */
    UCNV_UTF32_LittleEndian = 8,
    /** @stable ICU 2.0 */
    UCNV_EBCDIC_STATEFUL = 9,
    /** @stable ICU 2.0 */
    UCNV_ISO_2022 = 10,

    /** @stable ICU 2.0 */
    UCNV_LMBCS_1 = 11,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_2,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_3,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_4,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_5,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_6,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_8,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_11,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_16,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_17,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_18,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_19,
    /** @stable ICU 2.0 */
    UCNV_LMBCS_LAST = UCNV_LMBCS_19,
    /** @stable ICU 2.0 */
    UCNV_HZ,
    /** @stable ICU 2.0 */
    UCNV_SCSU,
    /** @stable ICU 2.0 */
    UCNV_ISCII,
    /** @stable ICU 2.0 */
    UCNV_US_ASCII,
    /** @stable ICU 2.0 */
    UCNV_UTF7,
    /** @stable ICU 2.2 */
    UCNV_BOCU1,
    /** @stable ICU 2.2 */
    UCNV_UTF16,
    /** @stable ICU 2.2 */
    UCNV_UTF32,
    /** @stable ICU 2.2 */
    UCNV_CESU8,
    /** @stable ICU 2.4 */
    UCNV_IMAP_MAILBOX,
    /** @stable ICU 4.8 */
    UCNV_COMPOUND_TEXT,

    /* Number of converter types for which we have conversion routines. */
    UCNV_NUMBER_OF_SUPPORTED_CONVERTER_TYPES
} UConverterType;

/**
 * Enum for specifying which platform a converter ID refers to.
 * The use of platform/CCSID is not recommended. See ucnv_openCCSID().
 *
 * @see ucnv_getPlatform
 * @see ucnv_openCCSID
 * @see ucnv_getCCSID
 * @stable ICU 2.0
 */
typedef enum {
    UCNV_UNKNOWN = -1,
    UCNV_IBM = 0
} UConverterPlatform;

/**
 * Function pointer for error callback in the codepage to unicode direction.
 * Called when an error has occurred in conversion to unicode, or on open/close of the callback (see reason).
 * @param context Pointer to the callback's private data
 * @param args Information about the conversion in progress
 * @param codeUnits Points to 'length' bytes of the concerned codepage sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param reason Defines the reason the callback was invoked
 * @param pErrorCode    ICU error code in/out parameter.
 *                      For converter callback functions, set to a conversion error
 *                      before the call, and the callback may reset it to U_ZERO_ERROR.
 * @see ucnv_setToUCallBack
 * @see UConverterToUnicodeArgs
 * @stable ICU 2.0
 */
typedef void (U_EXPORT2 *UConverterToUCallback) (
                  const void* context,
                  UConverterToUnicodeArgs *args,
                  const char *codeUnits,
                  int32_t length,
                  UConverterCallbackReason reason,
                  UErrorCode *pErrorCode);

/**
 * Function pointer for error callback in the unicode to codepage direction.
 * Called when an error has occurred in conversion from unicode, or on open/close of the callback (see reason).
 * @param context Pointer to the callback's private data
 * @param args Information about the conversion in progress
 * @param codeUnits Points to 'length' UChars of the concerned Unicode sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param codePoint Single UChar32 (UTF-32) containing the concerend Unicode codepoint.
 * @param reason Defines the reason the callback was invoked
 * @param pErrorCode    ICU error code in/out parameter.
 *                      For converter callback functions, set to a conversion error
 *                      before the call, and the callback may reset it to U_ZERO_ERROR.
 * @see ucnv_setFromUCallBack
 * @stable ICU 2.0
 */
typedef void (U_EXPORT2 *UConverterFromUCallback) (
                    const void* context,
                    UConverterFromUnicodeArgs *args,
                    const UChar* codeUnits,
                    int32_t length,
                    UChar32 codePoint,
                    UConverterCallbackReason reason,
                    UErrorCode *pErrorCode);

U_CDECL_END

/**
 * Character that separates converter names from options and options from each other.
 * @see ucnv_open
 * @stable ICU 2.0
 */
#define UCNV_OPTION_SEP_CHAR ','

/**
 * String version of UCNV_OPTION_SEP_CHAR.
 * @see ucnv_open
 * @stable ICU 2.0
 */
#define UCNV_OPTION_SEP_STRING ","

/**
 * Character that separates a converter option from its value.
 * @see ucnv_open
 * @stable ICU 2.0
 */
#define UCNV_VALUE_SEP_CHAR '='

/**
 * String version of UCNV_VALUE_SEP_CHAR.
 * @see ucnv_open
 * @stable ICU 2.0
 */
#define UCNV_VALUE_SEP_STRING "="

/**
 * Converter option for specifying a locale.
 * For example, ucnv_open("SCSU,locale=ja", &errorCode);
 * See convrtrs.txt.
 *
 * @see ucnv_open
 * @stable ICU 2.0
 */
#define UCNV_LOCALE_OPTION_STRING ",locale="

/**
 * Converter option for specifying a version selector (0..9) for some converters.
 * For example,
 * \code
 *   ucnv_open("UTF-7,version=1", &errorCode);
 * \endcode
 * See convrtrs.txt.
 *
 * @see ucnv_open
 * @stable ICU 2.4
 */
#define UCNV_VERSION_OPTION_STRING ",version="

/**
 * Converter option for EBCDIC SBCS or mixed-SBCS/DBCS (stateful) codepages.
 * Swaps Unicode mappings for EBCDIC LF and NL codes, as used on
 * S/390 (z/OS) Unix System Services (Open Edition).
 * For example, ucnv_open("ibm-1047,swaplfnl", &errorCode);
 * See convrtrs.txt.
 *
 * @see ucnv_open
 * @stable ICU 2.4
 */
#define UCNV_SWAP_LFNL_OPTION_STRING ",swaplfnl"

/**
 * Do a fuzzy compare of two converter/alias names.
 * The comparison is case-insensitive, ignores leading zeroes if they are not
 * followed by further digits, and ignores all but letters and digits.
 * Thus the strings "UTF-8", "utf_8", "u*T@f08" and "Utf 8" are exactly equivalent.
 * See section 1.4, Charset Alias Matching in Unicode Technical Standard #22
 * at http://www.unicode.org/reports/tr22/
 *
 * @param name1 a converter name or alias, zero-terminated
 * @param name2 a converter name or alias, zero-terminated
 * @return 0 if the names match, or a negative value if the name1
 * lexically precedes name2, or a positive value if the name1
 * lexically follows name2.
 * @stable ICU 2.0
 */
U_CAPI int U_EXPORT2
ucnv_compareNames(const char *name1, const char *name2);


/**
 * Creates a UConverter object with the name of a coded character set specified as a C string.
 * The actual name will be resolved with the alias file
 * using a case-insensitive string comparison that ignores
 * leading zeroes and all non-alphanumeric characters.
 * E.g., the names "UTF8", "utf-8", "u*T@f08" and "Utf 8" are all equivalent.
 * (See also ucnv_compareNames().)
 * If <code>NULL</code> is passed for the converter name, it will create one with the
 * getDefaultName return value.
 *
 * <p>A converter name for ICU 1.5 and above may contain options
 * like a locale specification to control the specific behavior of
 * the newly instantiated converter.
 * The meaning of the options depends on the particular converter.
 * If an option is not defined for or recognized by a given converter, then it is ignored.</p>
 *
 * <p>Options are appended to the converter name string, with a
 * <code>UCNV_OPTION_SEP_CHAR</code> between the name and the first option and
 * also between adjacent options.</p>
 *
 * <p>If the alias is ambiguous, then the preferred converter is used
 * and the status is set to U_AMBIGUOUS_ALIAS_WARNING.</p>
 *
 * <p>The conversion behavior and names can vary between platforms. ICU may
 * convert some characters differently from other platforms. Details on this topic
 * are in the <a href="https://unicode-org.github.io/icu/userguide/conversion/">User
 * Guide</a>. Aliases starting with a "cp" prefix have no specific meaning
 * other than its an alias starting with the letters "cp". Please do not
 * associate any meaning to these aliases.</p>
 *
 * @param converterName Name of the coded character set table.
 *          This may have options appended to the string.
 *          IANA alias character set names, IBM CCSIDs starting with "ibm-",
 *          Windows codepage numbers starting with "windows-" are frequently
 *          used for this parameter. See ucnv_getAvailableName and
 *          ucnv_getAlias for a complete list that is available.
 *          If this parameter is NULL, the default converter will be used.
 * @param err outgoing error status <TT>U_MEMORY_ALLOCATION_ERROR, U_FILE_ACCESS_ERROR</TT>
 * @return the created Unicode converter object, or <TT>NULL</TT> if an error occurred
 * @see ucnv_openU
 * @see ucnv_openCCSID
 * @see ucnv_getAvailableName
 * @see ucnv_getAlias
 * @see ucnv_getDefaultName
 * @see ucnv_close
 * @see ucnv_compareNames
 * @stable ICU 2.0
 */
U_CAPI UConverter* U_EXPORT2
ucnv_open(const char *converterName, UErrorCode *err);


/**
 * Creates a Unicode converter with the names specified as unicode string.
 * The name should be limited to the ASCII-7 alphanumerics range.
 * The actual name will be resolved with the alias file
 * using a case-insensitive string comparison that ignores
 * leading zeroes and all non-alphanumeric characters.
 * E.g., the names "UTF8", "utf-8", "u*T@f08" and "Utf 8" are all equivalent.
 * (See also ucnv_compareNames().)
 * If <TT>NULL</TT> is passed for the converter name, it will create
 * one with the ucnv_getDefaultName() return value.
 * If the alias is ambiguous, then the preferred converter is used
 * and the status is set to U_AMBIGUOUS_ALIAS_WARNING.
 *
 * <p>See ucnv_open for the complete details</p>
 * @param name Name of the UConverter table in a zero terminated
 *        Unicode string
 * @param err outgoing error status <TT>U_MEMORY_ALLOCATION_ERROR,
 *        U_FILE_ACCESS_ERROR</TT>
 * @return the created Unicode converter object, or <TT>NULL</TT> if an
 *        error occurred
 * @see ucnv_open
 * @see ucnv_openCCSID
 * @see ucnv_close
 * @see ucnv_compareNames
 * @stable ICU 2.0
 */
U_CAPI UConverter* U_EXPORT2
ucnv_openU(const UChar *name,
           UErrorCode *err);

/**
 * Creates a UConverter object from a CCSID number and platform pair.
 * Note that the usefulness of this function is limited to platforms with numeric
 * encoding IDs. Only IBM and Microsoft platforms use numeric (16-bit) identifiers for
 * encodings.
 *
 * In addition, IBM CCSIDs and Unicode conversion tables are not 1:1 related.
 * For many IBM CCSIDs there are multiple (up to six) Unicode conversion tables, and
 * for some Unicode conversion tables there are multiple CCSIDs.
 * Some "alternate" Unicode conversion tables are provided by the
 * IBM CDRA conversion table registry.
 * The most prominent example of a systematic modification of conversion tables that is
 * not provided in the form of conversion table files in the repository is
 * that S/390 Unix System Services swaps the codes for Line Feed and New Line in all
 * EBCDIC codepages, which requires such a swap in the Unicode conversion tables as well.
 *
 * Only IBM default conversion tables are accessible with ucnv_openCCSID().
 * ucnv_getCCSID() will return the same CCSID for all conversion tables that are associated
 * with that CCSID.
 *
 * Currently, the only "platform" supported in the ICU converter API is UCNV_IBM.
 *
 * In summary, the use of CCSIDs and the associated API functions is not recommended.
 *
 * In order to open a converter with the default IBM CDRA Unicode conversion table,
 * you can use this function or use the prefix "ibm-":
 * \code
 *     char name[20];
 *     sprintf(name, "ibm-%hu", ccsid);
 *     cnv=ucnv_open(name, &errorCode);
 * \endcode
 *
 * In order to open a converter with the IBM S/390 Unix System Services variant
 * of a Unicode/EBCDIC conversion table,
 * you can use the prefix "ibm-" together with the option string UCNV_SWAP_LFNL_OPTION_STRING:
 * \code
 *     char name[20];
 *     sprintf(name, "ibm-%hu" UCNV_SWAP_LFNL_OPTION_STRING, ccsid);
 *     cnv=ucnv_open(name, &errorCode);
 * \endcode
 *
 * In order to open a converter from a Microsoft codepage number, use the prefix "cp":
 * \code
 *     char name[20];
 *     sprintf(name, "cp%hu", codepageID);
 *     cnv=ucnv_open(name, &errorCode);
 * \endcode
 *
 * If the alias is ambiguous, then the preferred converter is used
 * and the status is set to U_AMBIGUOUS_ALIAS_WARNING.
 *
 * @param codepage codepage number to create
 * @param platform the platform in which the codepage number exists
 * @param err error status <TT>U_MEMORY_ALLOCATION_ERROR, U_FILE_ACCESS_ERROR</TT>
 * @return the created Unicode converter object, or <TT>NULL</TT> if an error
 *   occurred.
 * @see ucnv_open
 * @see ucnv_openU
 * @see ucnv_close
 * @see ucnv_getCCSID
 * @see ucnv_getPlatform
 * @see UConverterPlatform
 * @stable ICU 2.0
 */
U_CAPI UConverter* U_EXPORT2
ucnv_openCCSID(int32_t codepage,
               UConverterPlatform platform,
               UErrorCode * err);

/**
 * <p>Creates a UConverter object specified from a packageName and a converterName.</p>
 *
 * <p>The packageName and converterName must point to an ICU udata object, as defined by
 *   <code> udata_open( packageName, "cnv", converterName, err) </code> or equivalent.
 * Typically, packageName will refer to a (.dat) file, or to a package registered with
 * udata_setAppData(). Using a full file or directory pathname for packageName is deprecated.</p>
 *
 * <p>The name will NOT be looked up in the alias mechanism, nor will the converter be
 * stored in the converter cache or the alias table. The only way to open further converters
 * is call this function multiple times, or use the ucnv_clone() function to clone a
 * 'primary' converter.</p>
 *
 * <p>A future version of ICU may add alias table lookups and/or caching
 * to this function.</p>
 *
 * <p>Example Use:
 *      <code>cnv = ucnv_openPackage("myapp", "myconverter", &err);</code>
 * </p>
 *
 * @param packageName name of the package (equivalent to 'path' in udata_open() call)
 * @param converterName name of the data item to be used, without suffix.
 * @param err outgoing error status <TT>U_MEMORY_ALLOCATION_ERROR, U_FILE_ACCESS_ERROR</TT>
 * @return the created Unicode converter object, or <TT>NULL</TT> if an error occurred
 * @see udata_open
 * @see ucnv_open
 * @see ucnv_clone
 * @see ucnv_close
 * @stable ICU 2.2
 */
U_CAPI UConverter* U_EXPORT2
ucnv_openPackage(const char *packageName, const char *converterName, UErrorCode *err);

/**
 * Thread safe converter cloning operation.
 *
 * You must ucnv_close() the clone.
 *
 * @param cnv converter to be cloned
 * @param status to indicate whether the operation went on smoothly or there were errors
 * @return pointer to the new clone
 * @stable ICU 71
 */
U_CAPI UConverter* U_EXPORT2 ucnv_clone(const UConverter *cnv, UErrorCode *status);

#ifndef U_HIDE_DEPRECATED_API

/**
 * Thread safe converter cloning operation.
 * For most efficient operation, pass in a stackBuffer (and a *pBufferSize)
 * with at least U_CNV_SAFECLONE_BUFFERSIZE bytes of space.
 * If the buffer size is sufficient, then the clone will use the stack buffer;
 * otherwise, it will be allocated, and *pBufferSize will indicate
 * the actual size. (This should not occur with U_CNV_SAFECLONE_BUFFERSIZE.)
 *
 * You must ucnv_close() the clone in any case.
 *
 * If *pBufferSize==0, (regardless of whether stackBuffer==NULL or not)
 * then *pBufferSize will be changed to a sufficient size
 * for cloning this converter,
 * without actually cloning the converter ("pure pre-flighting").
 *
 * If *pBufferSize is greater than zero but not large enough for a stack-based
 * clone, then the converter is cloned using newly allocated memory
 * and *pBufferSize is changed to the necessary size.
 *
 * If the converter clone fits into the stack buffer but the stack buffer is not
 * sufficiently aligned for the clone, then the clone will use an
 * adjusted pointer and use an accordingly smaller buffer size.
 *
 * @param cnv converter to be cloned
 * @param stackBuffer <em>Deprecated functionality as of ICU 52, use NULL.</em><br>
 *  user allocated space for the new clone. If NULL new memory will be allocated.
 *  If buffer is not large enough, new memory will be allocated.
 *  Clients can use the U_CNV_SAFECLONE_BUFFERSIZE. This will probably be enough to avoid memory allocations.
 * @param pBufferSize <em>Deprecated functionality as of ICU 52, use NULL or 1.</em><br>
 *  pointer to size of allocated space.
 * @param status to indicate whether the operation went on smoothly or there were errors
 *  An informational status value, U_SAFECLONE_ALLOCATED_WARNING,
 *  is used if pBufferSize != NULL and any allocations were necessary
 *  However, it is better to check if *pBufferSize grew for checking for
 *  allocations because warning codes can be overridden by subsequent
 *  function calls.
 * @return pointer to the new clone
 * @deprecated ICU 71 Use ucnv_clone() instead.
 */
U_DEPRECATED UConverter * U_EXPORT2
ucnv_safeClone(const UConverter *cnv,
               void             *stackBuffer,
               int32_t          *pBufferSize,
               UErrorCode       *status);

/**
 * \def U_CNV_SAFECLONE_BUFFERSIZE
 * Definition of a buffer size that is designed to be large enough for
 * converters to be cloned with ucnv_safeClone().
 * @deprecated ICU 52. Do not rely on ucnv_safeClone() cloning into any provided buffer.
 */
#define U_CNV_SAFECLONE_BUFFERSIZE  1024

#endif /* U_HIDE_DEPRECATED_API */

/**
 * Deletes the unicode converter and releases resources associated
 * with just this instance.
 * Does not free up shared converter tables.
 *
 * @param converter the converter object to be deleted
 * @see ucnv_open
 * @see ucnv_openU
 * @see ucnv_openCCSID
 * @stable ICU 2.0
 */
U_CAPI void  U_EXPORT2
ucnv_close(UConverter * converter);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUConverterPointer
 * "Smart pointer" class, closes a UConverter via ucnv_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUConverterPointer, UConverter, ucnv_close);

U_NAMESPACE_END

#endif

/**
 * Fills in the output parameter, subChars, with the substitution characters
 * as multiple bytes.
 * If ucnv_setSubstString() set a Unicode string because the converter is
 * stateful, then subChars will be an empty string.
 *
 * @param converter the Unicode converter
 * @param subChars the substitution characters
 * @param len on input the capacity of subChars, on output the number
 * of bytes copied to it
 * @param  err the outgoing error status code.
 * If the substitution character array is too small, an
 * <TT>U_INDEX_OUTOFBOUNDS_ERROR</TT> will be returned.
 * @see ucnv_setSubstString
 * @see ucnv_setSubstChars
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_getSubstChars(const UConverter *converter,
                   char *subChars,
                   int8_t *len,
                   UErrorCode *err);

/**
 * Sets the substitution chars when converting from unicode to a codepage. The
 * substitution is specified as a string of 1-4 bytes, and may contain
 * <TT>NULL</TT> bytes.
 * The subChars must represent a single character. The caller needs to know the
 * byte sequence of a valid character in the converter's charset.
 * For some converters, for example some ISO 2022 variants, only single-byte
 * substitution characters may be supported.
 * The newer ucnv_setSubstString() function relaxes these limitations.
 *
 * @param converter the Unicode converter
 * @param subChars the substitution character byte sequence we want set
 * @param len the number of bytes in subChars
 * @param err the error status code.  <TT>U_INDEX_OUTOFBOUNDS_ERROR </TT> if
 * len is bigger than the maximum number of bytes allowed in subchars
 * @see ucnv_setSubstString
 * @see ucnv_getSubstChars
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_setSubstChars(UConverter *converter,
                   const char *subChars,
                   int8_t len,
                   UErrorCode *err);

/**
 * Set a substitution string for converting from Unicode to a charset.
 * The caller need not know the charset byte sequence for each charset.
 *
 * Unlike ucnv_setSubstChars() which is designed to set a charset byte sequence
 * for a single character, this function takes a Unicode string with
 * zero, one or more characters, and immediately verifies that the string can be
 * converted to the charset.
 * If not, or if the result is too long (more than 32 bytes as of ICU 3.6),
 * then the function returns with an error accordingly.
 *
 * Also unlike ucnv_setSubstChars(), this function works for stateful charsets
 * by converting on the fly at the point of substitution rather than setting
 * a fixed byte sequence.
 *
 * @param cnv The UConverter object.
 * @param s The Unicode string.
 * @param length The number of UChars in s, or -1 for a NUL-terminated string.
 * @param err Pointer to a standard ICU error code. Its input value must
 *            pass the U_SUCCESS() test, or else the function returns
 *            immediately. Check for U_FAILURE() on output or use with
 *            function chaining. (See User Guide for details.)
 *
 * @see ucnv_setSubstChars
 * @see ucnv_getSubstChars
 * @stable ICU 3.6
 */
U_CAPI void U_EXPORT2
ucnv_setSubstString(UConverter *cnv,
                    const UChar *s,
                    int32_t length,
                    UErrorCode *err);

/**
 * Fills in the output parameter, errBytes, with the error characters from the
 * last failing conversion.
 *
 * @param converter the Unicode converter
 * @param errBytes the codepage bytes which were in error
 * @param len on input the capacity of errBytes, on output the number of
 *  bytes which were copied to it
 * @param err the error status code.
 * If the substitution character array is too small, an
 * <TT>U_INDEX_OUTOFBOUNDS_ERROR</TT> will be returned.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_getInvalidChars(const UConverter *converter,
                     char *errBytes,
                     int8_t *len,
                     UErrorCode *err);

/**
 * Fills in the output parameter, errChars, with the error characters from the
 * last failing conversion.
 *
 * @param converter the Unicode converter
 * @param errUChars the UChars which were in error
 * @param len on input the capacity of errUChars, on output the number of
 *  UChars which were copied to it
 * @param err the error status code.
 * If the substitution character array is too small, an
 * <TT>U_INDEX_OUTOFBOUNDS_ERROR</TT> will be returned.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_getInvalidUChars(const UConverter *converter,
                      UChar *errUChars,
                      int8_t *len,
                      UErrorCode *err);

/**
 * Resets the state of a converter to the default state. This is used
 * in the case of an error, to restart a conversion from a known default state.
 * It will also empty the internal output buffers.
 * @param converter the Unicode converter
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_reset(UConverter *converter);

/**
 * Resets the to-Unicode part of a converter state to the default state.
 * This is used in the case of an error to restart a conversion to
 * Unicode to a known default state. It will also empty the internal
 * output buffers used for the conversion to Unicode codepoints.
 * @param converter the Unicode converter
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_resetToUnicode(UConverter *converter);

/**
 * Resets the from-Unicode part of a converter state to the default state.
 * This is used in the case of an error to restart a conversion from
 * Unicode to a known default state. It will also empty the internal output
 * buffers used for the conversion from Unicode codepoints.
 * @param converter the Unicode converter
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_resetFromUnicode(UConverter *converter);

/**
 * Returns the maximum number of bytes that are output per UChar in conversion
 * from Unicode using this converter.
 * The returned number can be used with UCNV_GET_MAX_BYTES_FOR_STRING
 * to calculate the size of a target buffer for conversion from Unicode.
 *
 * Note: Before ICU 2.8, this function did not return reliable numbers for
 * some stateful converters (EBCDIC_STATEFUL, ISO-2022) and LMBCS.
 *
 * This number may not be the same as the maximum number of bytes per
 * "conversion unit". In other words, it may not be the intuitively expected
 * number of bytes per character that would be published for a charset,
 * and may not fulfill any other purpose than the allocation of an output
 * buffer of guaranteed sufficient size for a given input length and converter.
 *
 * Examples for special cases that are taken into account:
 * - Supplementary code points may convert to more bytes than BMP code points.
 *   This function returns bytes per UChar (UTF-16 code unit), not per
 *   Unicode code point, for efficient buffer allocation.
 * - State-shifting output (SI/SO, escapes, etc.) from stateful converters.
 * - When m input UChars are converted to n output bytes, then the maximum m/n
 *   is taken into account.
 *
 * The number returned here does not take into account
 * (see UCNV_GET_MAX_BYTES_FOR_STRING):
 * - callbacks which output more than one charset character sequence per call,
 *   like escape callbacks
 * - initial and final non-character bytes that are output by some converters
 *   (automatic BOMs, initial escape sequence, final SI, etc.)
 *
 * Examples for returned values:
 * - SBCS charsets: 1
 * - Shift-JIS: 2
 * - UTF-16: 2 (2 per BMP, 4 per surrogate _pair_, BOM not counted)
 * - UTF-8: 3 (3 per BMP, 4 per surrogate _pair_)
 * - EBCDIC_STATEFUL (EBCDIC mixed SBCS/DBCS): 3 (SO + DBCS)
 * - ISO-2022: 3 (always outputs UTF-8)
 * - ISO-2022-JP: 6 (4-byte escape sequences + DBCS)
 * - ISO-2022-CN: 8 (4-byte designator sequences + 2-byte SS2/SS3 + DBCS)
 *
 * @param converter The Unicode converter.
 * @return The maximum number of bytes per UChar (16 bit code unit)
 *    that are output by ucnv_fromUnicode(),
 *    to be used together with UCNV_GET_MAX_BYTES_FOR_STRING
 *    for buffer allocation.
 *
 * @see UCNV_GET_MAX_BYTES_FOR_STRING
 * @see ucnv_getMinCharSize
 * @stable ICU 2.0
 */
U_CAPI int8_t U_EXPORT2
ucnv_getMaxCharSize(const UConverter *converter);

/**
 * Calculates the size of a buffer for conversion from Unicode to a charset.
 * The calculated size is guaranteed to be sufficient for this conversion.
 *
 * It takes into account initial and final non-character bytes that are output
 * by some converters.
 * It does not take into account callbacks which output more than one charset
 * character sequence per call, like escape callbacks.
 * The default (substitution) callback only outputs one charset character sequence.
 *
 * @param length Number of UChars to be converted.
 * @param maxCharSize Return value from ucnv_getMaxCharSize() for the converter
 *                    that will be used.
 * @return Size of a buffer that will be large enough to hold the output bytes of
 *         converting length UChars with the converter that returned the maxCharSize.
 *
 * @see ucnv_getMaxCharSize
 * @stable ICU 2.8
 */
#define UCNV_GET_MAX_BYTES_FOR_STRING(length, maxCharSize) \
     (((int32_t)(length)+10)*(int32_t)(maxCharSize))

/**
 * Returns the minimum byte length (per codepoint) for characters in this codepage.
 * This is usually either 1 or 2.
 * @param converter the Unicode converter
 * @return the minimum number of bytes per codepoint allowed by this particular converter
 * @see ucnv_getMaxCharSize
 * @stable ICU 2.0
 */
U_CAPI int8_t U_EXPORT2
ucnv_getMinCharSize(const UConverter *converter);

/**
 * Returns the display name of the converter passed in based on the Locale
 * passed in. If the locale contains no display name, the internal ASCII
 * name will be filled in.
 *
 * @param converter the Unicode converter.
 * @param displayLocale is the specific Locale we want to localized for
 * @param displayName user provided buffer to be filled in
 * @param displayNameCapacity size of displayName Buffer
 * @param err error status code
 * @return displayNameLength number of UChar needed in displayName
 * @see ucnv_getName
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ucnv_getDisplayName(const UConverter *converter,
                    const char *displayLocale,
                    UChar *displayName,
                    int32_t displayNameCapacity,
                    UErrorCode *err);

/**
 * Gets the internal, canonical name of the converter (zero-terminated).
 * The lifetime of the returned string will be that of the converter
 * passed to this function.
 * @param converter the Unicode converter
 * @param err UErrorCode status
 * @return the internal name of the converter
 * @see ucnv_getDisplayName
 * @stable ICU 2.0
 */
U_CAPI const char * U_EXPORT2
ucnv_getName(const UConverter *converter, UErrorCode *err);

/**
 * Gets a codepage number associated with the converter. This is not guaranteed
 * to be the one used to create the converter. Some converters do not represent
 * platform registered codepages and return zero for the codepage number.
 * The error code fill-in parameter indicates if the codepage number
 * is available.
 * Does not check if the converter is <TT>NULL</TT> or if converter's data
 * table is <TT>NULL</TT>.
 *
 * Important: The use of CCSIDs is not recommended because it is limited
 * to only two platforms in principle and only one (UCNV_IBM) in the current
 * ICU converter API.
 * Also, CCSIDs are insufficient to identify IBM Unicode conversion tables precisely.
 * For more details see ucnv_openCCSID().
 *
 * @param converter the Unicode converter
 * @param err the error status code.
 * @return If any error occurs, -1 will be returned otherwise, the codepage number
 * will be returned
 * @see ucnv_openCCSID
 * @see ucnv_getPlatform
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ucnv_getCCSID(const UConverter *converter,
              UErrorCode *err);

/**
 * Gets a codepage platform associated with the converter. Currently,
 * only <TT>UCNV_IBM</TT> will be returned.
 * Does not test if the converter is <TT>NULL</TT> or if converter's data
 * table is <TT>NULL</TT>.
 * @param converter the Unicode converter
 * @param err the error status code.
 * @return The codepage platform
 * @stable ICU 2.0
 */
U_CAPI UConverterPlatform U_EXPORT2
ucnv_getPlatform(const UConverter *converter,
                 UErrorCode *err);

/**
 * Gets the type of the converter
 * e.g. SBCS, MBCS, DBCS, UTF8, UTF16_BE, UTF16_LE, ISO_2022,
 * EBCDIC_STATEFUL, LATIN_1
 * @param converter a valid, opened converter
 * @return the type of the converter
 * @stable ICU 2.0
 */
U_CAPI UConverterType U_EXPORT2
ucnv_getType(const UConverter * converter);

/**
 * Gets the "starter" (lead) bytes for converters of type MBCS.
 * Will fill in an <TT>U_ILLEGAL_ARGUMENT_ERROR</TT> if converter passed in
 * is not MBCS. Fills in an array of type UBool, with the value of the byte
 * as offset to the array. For example, if (starters[0x20] == true) at return,
 * it means that the byte 0x20 is a starter byte in this converter.
 * Context pointers are always owned by the caller.
 *
 * @param converter a valid, opened converter of type MBCS
 * @param starters an array of size 256 to be filled in
 * @param err error status, <TT>U_ILLEGAL_ARGUMENT_ERROR</TT> if the
 * converter is not a type which can return starters.
 * @see ucnv_getType
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_getStarters(const UConverter* converter,
                 UBool starters[256],
                 UErrorCode* err);


/**
 * Selectors for Unicode sets that can be returned by ucnv_getUnicodeSet().
 * @see ucnv_getUnicodeSet
 * @stable ICU 2.6
 */
typedef enum UConverterUnicodeSet {
    /** Select the set of roundtrippable Unicode code points. @stable ICU 2.6 */
    UCNV_ROUNDTRIP_SET,
    /** Select the set of Unicode code points with roundtrip or fallback mappings. @stable ICU 4.0 */
    UCNV_ROUNDTRIP_AND_FALLBACK_SET,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * Number of UConverterUnicodeSet selectors.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UCNV_SET_COUNT
#endif  // U_HIDE_DEPRECATED_API
} UConverterUnicodeSet;


/**
 * Returns the set of Unicode code points that can be converted by an ICU converter.
 *
 * Returns one of several kinds of set:
 *
 * 1. UCNV_ROUNDTRIP_SET
 *
 * The set of all Unicode code points that can be roundtrip-converted
 * (converted without any data loss) with the converter (ucnv_fromUnicode()).
 * This set will not include code points that have fallback mappings
 * or are only the result of reverse fallback mappings.
 * This set will also not include PUA code points with fallbacks, although
 * ucnv_fromUnicode() will always uses those mappings despite ucnv_setFallback().
 * See UTR #22 "Character Mapping Markup Language"
 * at http://www.unicode.org/reports/tr22/
 *
 * This is useful for example for
 * - checking that a string or document can be roundtrip-converted with a converter,
 *   without/before actually performing the conversion
 * - testing if a converter can be used for text for typical text for a certain locale,
 *   by comparing its roundtrip set with the set of ExemplarCharacters from
 *   ICU's locale data or other sources
 *
 * 2. UCNV_ROUNDTRIP_AND_FALLBACK_SET
 *
 * The set of all Unicode code points that can be converted with the converter (ucnv_fromUnicode())
 * when fallbacks are turned on (see ucnv_setFallback()).
 * This set includes all code points with roundtrips and fallbacks (but not reverse fallbacks).
 *
 * In the future, there may be more UConverterUnicodeSet choices to select
 * sets with different properties.
 *
 * @param cnv The converter for which a set is requested.
 * @param setFillIn A valid USet *. It will be cleared by this function before
 *            the converter's specific set is filled into the USet.
 * @param whichSet A UConverterUnicodeSet selector;
 *              currently UCNV_ROUNDTRIP_SET is the only supported value.
 * @param pErrorCode ICU error code in/out parameter.
 *                   Must fulfill U_SUCCESS before the function call.
 *
 * @see UConverterUnicodeSet
 * @see uset_open
 * @see uset_close
 * @stable ICU 2.6
 */
U_CAPI void U_EXPORT2
ucnv_getUnicodeSet(const UConverter *cnv,
                   USet *setFillIn,
                   UConverterUnicodeSet whichSet,
                   UErrorCode *pErrorCode);

/**
 * Gets the current callback function used by the converter when an illegal
 *  or invalid codepage sequence is found.
 * Context pointers are always owned by the caller.
 *
 * @param converter the unicode converter
 * @param action fillin: returns the callback function pointer
 * @param context fillin: returns the callback's private void* context
 * @see ucnv_setToUCallBack
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_getToUCallBack (const UConverter * converter,
                     UConverterToUCallback *action,
                     const void **context);

/**
 * Gets the current callback function used by the converter when illegal
 * or invalid Unicode sequence is found.
 * Context pointers are always owned by the caller.
 *
 * @param converter the unicode converter
 * @param action fillin: returns the callback function pointer
 * @param context fillin: returns the callback's private void* context
 * @see ucnv_setFromUCallBack
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_getFromUCallBack (const UConverter * converter,
                       UConverterFromUCallback *action,
                       const void **context);

/**
 * Changes the callback function used by the converter when
 * an illegal or invalid sequence is found.
 * Context pointers are always owned by the caller.
 * Predefined actions and contexts can be found in the ucnv_err.h header.
 *
 * @param converter the unicode converter
 * @param newAction the new callback function
 * @param newContext the new toUnicode callback context pointer. This can be NULL.
 * @param oldAction fillin: returns the old callback function pointer. This can be NULL.
 * @param oldContext fillin: returns the old callback's private void* context. This can be NULL.
 * @param err The error code status
 * @see ucnv_getToUCallBack
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_setToUCallBack (UConverter * converter,
                     UConverterToUCallback newAction,
                     const void* newContext,
                     UConverterToUCallback *oldAction,
                     const void** oldContext,
                     UErrorCode * err);

/**
 * Changes the current callback function used by the converter when
 * an illegal or invalid sequence is found.
 * Context pointers are always owned by the caller.
 * Predefined actions and contexts can be found in the ucnv_err.h header.
 *
 * @param converter the unicode converter
 * @param newAction the new callback function
 * @param newContext the new fromUnicode callback context pointer. This can be NULL.
 * @param oldAction fillin: returns the old callback function pointer. This can be NULL.
 * @param oldContext fillin: returns the old callback's private void* context. This can be NULL.
 * @param err The error code status
 * @see ucnv_getFromUCallBack
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_setFromUCallBack (UConverter * converter,
                       UConverterFromUCallback newAction,
                       const void *newContext,
                       UConverterFromUCallback *oldAction,
                       const void **oldContext,
                       UErrorCode * err);

/**
 * Converts an array of unicode characters to an array of codepage
 * characters. This function is optimized for converting a continuous
 * stream of data in buffer-sized chunks, where the entire source and
 * target does not fit in available buffers.
 *
 * The source pointer is an in/out parameter. It starts out pointing where the
 * conversion is to begin, and ends up pointing after the last UChar consumed.
 *
 * Target similarly starts out pointer at the first available byte in the output
 * buffer, and ends up pointing after the last byte written to the output.
 *
 * The converter always attempts to consume the entire source buffer, unless
 * (1.) the target buffer is full, or (2.) a failing error is returned from the
 * current callback function.  When a successful error status has been
 * returned, it means that all of the source buffer has been
 *  consumed. At that point, the caller should reset the source and
 *  sourceLimit pointers to point to the next chunk.
 *
 * At the end of the stream (flush==true), the input is completely consumed
 * when *source==sourceLimit and no error code is set.
 * The converter object is then automatically reset by this function.
 * (This means that a converter need not be reset explicitly between data
 * streams if it finishes the previous stream without errors.)
 *
 * This is a <I>stateful</I> conversion. Additionally, even when all source data has
 * been consumed, some data may be in the converters' internal state.
 * Call this function repeatedly, updating the target pointers with
 * the next empty chunk of target in case of a
 * <TT>U_BUFFER_OVERFLOW_ERROR</TT>, and updating the source  pointers
 *  with the next chunk of source when a successful error status is
 * returned, until there are no more chunks of source data.
 * @param converter the Unicode converter
 * @param target I/O parameter. Input : Points to the beginning of the buffer to copy
 *  codepage characters to. Output : points to after the last codepage character copied
 *  to <TT>target</TT>.
 * @param targetLimit the pointer just after last of the <TT>target</TT> buffer
 * @param source I/O parameter, pointer to pointer to the source Unicode character buffer.
 * @param sourceLimit the pointer just after the last of the source buffer
 * @param offsets if NULL is passed, nothing will happen to it, otherwise it needs to have the same number
 * of allocated cells as <TT>target</TT>. Will fill in offsets from target to source pointer
 * e.g: <TT>offsets[3]</TT> is equal to 6, it means that the <TT>target[3]</TT> was a result of transcoding <TT>source[6]</TT>
 * For output data carried across calls, and other data without a specific source character
 * (such as from escape sequences or callbacks)  -1 will be placed for offsets.
 * @param flush set to <TT>true</TT> if the current source buffer is the last available
 * chunk of the source, <TT>false</TT> otherwise. Note that if a failing status is returned,
 * this function may have to be called multiple times with flush set to <TT>true</TT> until
 * the source buffer is consumed.
 * @param err the error status.  <TT>U_ILLEGAL_ARGUMENT_ERROR</TT> will be set if the
 * converter is <TT>NULL</TT>.
 * <code>U_BUFFER_OVERFLOW_ERROR</code> will be set if the target is full and there is
 * still data to be written to the target.
 * @see ucnv_fromUChars
 * @see ucnv_convert
 * @see ucnv_getMinCharSize
 * @see ucnv_setToUCallBack
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_fromUnicode (UConverter * converter,
                  char **target,
                  const char *targetLimit,
                  const UChar ** source,
                  const UChar * sourceLimit,
                  int32_t* offsets,
                  UBool flush,
                  UErrorCode * err);

/**
 * Converts a buffer of codepage bytes into an array of unicode UChars
 * characters. This function is optimized for converting a continuous
 * stream of data in buffer-sized chunks, where the entire source and
 * target does not fit in available buffers.
 *
 * The source pointer is an in/out parameter. It starts out pointing where the
 * conversion is to begin, and ends up pointing after the last byte of source consumed.
 *
 * Target similarly starts out pointer at the first available UChar in the output
 * buffer, and ends up pointing after the last UChar written to the output.
 * It does NOT necessarily keep UChar sequences together.
 *
 * The converter always attempts to consume the entire source buffer, unless
 * (1.) the target buffer is full, or (2.) a failing error is returned from the
 * current callback function.  When a successful error status has been
 * returned, it means that all of the source buffer has been
 *  consumed. At that point, the caller should reset the source and
 *  sourceLimit pointers to point to the next chunk.
 *
 * At the end of the stream (flush==true), the input is completely consumed
 * when *source==sourceLimit and no error code is set
 * The converter object is then automatically reset by this function.
 * (This means that a converter need not be reset explicitly between data
 * streams if it finishes the previous stream without errors.)
 *
 * This is a <I>stateful</I> conversion. Additionally, even when all source data has
 * been consumed, some data may be in the converters' internal state.
 * Call this function repeatedly, updating the target pointers with
 * the next empty chunk of target in case of a
 * <TT>U_BUFFER_OVERFLOW_ERROR</TT>, and updating the source  pointers
 *  with the next chunk of source when a successful error status is
 * returned, until there are no more chunks of source data.
 * @param converter the Unicode converter
 * @param target I/O parameter. Input : Points to the beginning of the buffer to copy
 *  UChars into. Output : points to after the last UChar copied.
 * @param targetLimit the pointer just after the end of the <TT>target</TT> buffer
 * @param source I/O parameter, pointer to pointer to the source codepage buffer.
 * @param sourceLimit the pointer to the byte after the end of the source buffer
 * @param offsets if NULL is passed, nothing will happen to it, otherwise it needs to have the same number
 * of allocated cells as <TT>target</TT>. Will fill in offsets from target to source pointer
 * e.g: <TT>offsets[3]</TT> is equal to 6, it means that the <TT>target[3]</TT> was a result of transcoding <TT>source[6]</TT>
 * For output data carried across calls, and other data without a specific source character
 * (such as from escape sequences or callbacks)  -1 will be placed for offsets.
 * @param flush set to <TT>true</TT> if the current source buffer is the last available
 * chunk of the source, <TT>false</TT> otherwise. Note that if a failing status is returned,
 * this function may have to be called multiple times with flush set to <TT>true</TT> until
 * the source buffer is consumed.
 * @param err the error status.  <TT>U_ILLEGAL_ARGUMENT_ERROR</TT> will be set if the
 * converter is <TT>NULL</TT>.
 * <code>U_BUFFER_OVERFLOW_ERROR</code> will be set if the target is full and there is
 * still data to be written to the target.
 * @see ucnv_fromUChars
 * @see ucnv_convert
 * @see ucnv_getMinCharSize
 * @see ucnv_setFromUCallBack
 * @see ucnv_getNextUChar
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_toUnicode(UConverter *converter,
               UChar **target,
               const UChar *targetLimit,
               const char **source,
               const char *sourceLimit,
               int32_t *offsets,
               UBool flush,
               UErrorCode *err);

/**
 * Convert the Unicode string into a codepage string using an existing UConverter.
 * The output string is NUL-terminated if possible.
 *
 * This function is a more convenient but less powerful version of ucnv_fromUnicode().
 * It is only useful for whole strings, not for streaming conversion.
 *
 * The maximum output buffer capacity required (barring output from callbacks) will be
 * UCNV_GET_MAX_BYTES_FOR_STRING(srcLength, ucnv_getMaxCharSize(cnv)).
 *
 * @param cnv the converter object to be used (ucnv_resetFromUnicode() will be called)
 * @param src the input Unicode string
 * @param srcLength the input string length, or -1 if NUL-terminated
 * @param dest destination string buffer, can be NULL if destCapacity==0
 * @param destCapacity the number of chars available at dest
 * @param pErrorCode normal ICU error code;
 *                  common error codes that may be set by this function include
 *                  U_BUFFER_OVERFLOW_ERROR, U_STRING_NOT_TERMINATED_WARNING,
 *                  U_ILLEGAL_ARGUMENT_ERROR, and conversion errors
 * @return the length of the output string, not counting the terminating NUL;
 *         if the length is greater than destCapacity, then the string will not fit
 *         and a buffer of the indicated length would need to be passed in
 * @see ucnv_fromUnicode
 * @see ucnv_convert
 * @see UCNV_GET_MAX_BYTES_FOR_STRING
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ucnv_fromUChars(UConverter *cnv,
                char *dest, int32_t destCapacity,
                const UChar *src, int32_t srcLength,
                UErrorCode *pErrorCode);

/**
 * Convert the codepage string into a Unicode string using an existing UConverter.
 * The output string is NUL-terminated if possible.
 *
 * This function is a more convenient but less powerful version of ucnv_toUnicode().
 * It is only useful for whole strings, not for streaming conversion.
 *
 * The maximum output buffer capacity required (barring output from callbacks) will be
 * 2*srcLength (each char may be converted into a surrogate pair).
 *
 * @param cnv the converter object to be used (ucnv_resetToUnicode() will be called)
 * @param src the input codepage string
 * @param srcLength the input string length, or -1 if NUL-terminated
 * @param dest destination string buffer, can be NULL if destCapacity==0
 * @param destCapacity the number of UChars available at dest
 * @param pErrorCode normal ICU error code;
 *                  common error codes that may be set by this function include
 *                  U_BUFFER_OVERFLOW_ERROR, U_STRING_NOT_TERMINATED_WARNING,
 *                  U_ILLEGAL_ARGUMENT_ERROR, and conversion errors
 * @return the length of the output string, not counting the terminating NUL;
 *         if the length is greater than destCapacity, then the string will not fit
 *         and a buffer of the indicated length would need to be passed in
 * @see ucnv_toUnicode
 * @see ucnv_convert
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ucnv_toUChars(UConverter *cnv,
              UChar *dest, int32_t destCapacity,
              const char *src, int32_t srcLength,
              UErrorCode *pErrorCode);

/**
 * Convert a codepage buffer into Unicode one character at a time.
 * The input is completely consumed when the U_INDEX_OUTOFBOUNDS_ERROR is set.
 *
 * Advantage compared to ucnv_toUnicode() or ucnv_toUChars():
 * - Faster for small amounts of data, for most converters, e.g.,
 *   US-ASCII, ISO-8859-1, UTF-8/16/32, and most "normal" charsets.
 *   (For complex converters, e.g., SCSU, UTF-7 and ISO 2022 variants,
 *    it uses ucnv_toUnicode() internally.)
 * - Convenient.
 *
 * Limitations compared to ucnv_toUnicode():
 * - Always assumes flush=true.
 *   This makes ucnv_getNextUChar() unsuitable for "streaming" conversion,
 *   that is, for where the input is supplied in multiple buffers,
 *   because ucnv_getNextUChar() will assume the end of the input at the end
 *   of the first buffer.
 * - Does not provide offset output.
 *
 * It is possible to "mix" ucnv_getNextUChar() and ucnv_toUnicode() because
 * ucnv_getNextUChar() uses the current state of the converter
 * (unlike ucnv_toUChars() which always resets first).
 * However, if ucnv_getNextUChar() is called after ucnv_toUnicode()
 * stopped in the middle of a character sequence (with flush=false),
 * then ucnv_getNextUChar() will always use the slower ucnv_toUnicode()
 * internally until the next character boundary.
 * (This is new in ICU 2.6. In earlier releases, ucnv_getNextUChar() had to
 * start at a character boundary.)
 *
 * Instead of using ucnv_getNextUChar(), it is recommended
 * to convert using ucnv_toUnicode() or ucnv_toUChars()
 * and then iterate over the text using U16_NEXT() or a UCharIterator (uiter.h)
 * or a C++ CharacterIterator or similar.
 * This allows streaming conversion and offset output, for example.
 *
 * <p>Handling of surrogate pairs and supplementary-plane code points:<br>
 * There are two different kinds of codepages that provide mappings for surrogate characters:
 * <ul>
 *   <li>Codepages like UTF-8, UTF-32, and GB 18030 provide direct representations for Unicode
 *       code points U+10000-U+10ffff as well as for single surrogates U+d800-U+dfff.
 *       Each valid sequence will result in exactly one returned code point.
 *       If a sequence results in a single surrogate, then that will be returned
 *       by itself, even if a neighboring sequence encodes the matching surrogate.</li>
 *   <li>Codepages like SCSU and LMBCS (and UTF-16) provide direct representations only for BMP code points
 *       including surrogates. Code points in supplementary planes are represented with
 *       two sequences, each encoding a surrogate.
 *       For these codepages, matching pairs of surrogates will be combined into single
 *       code points for returning from this function.
 *       (Note that SCSU is actually a mix of these codepage types.)</li>
 * </ul></p>
 *
 * @param converter an open UConverter
 * @param source the address of a pointer to the codepage buffer, will be
 *  updated to point after the bytes consumed in the conversion call.
 * @param sourceLimit points to the end of the input buffer
 * @param err fills in error status (see ucnv_toUnicode)
 * <code>U_INDEX_OUTOFBOUNDS_ERROR</code> will be set if the input
 * is empty or does not convert to any output (e.g.: pure state-change
 * codes SI/SO, escape sequences for ISO 2022,
 * or if the callback did not output anything, ...).
 * This function will not set a <code>U_BUFFER_OVERFLOW_ERROR</code> because
 *  the "buffer" is the return code. However, there might be subsequent output
 *  stored in the converter object
 * that will be returned in following calls to this function.
 * @return a UChar32 resulting from the partial conversion of source
 * @see ucnv_toUnicode
 * @see ucnv_toUChars
 * @see ucnv_convert
 * @stable ICU 2.0
 */
U_CAPI UChar32 U_EXPORT2
ucnv_getNextUChar(UConverter * converter,
                  const char **source,
                  const char * sourceLimit,
                  UErrorCode * err);

/**
 * Convert from one external charset to another using two existing UConverters.
 * Internally, two conversions - ucnv_toUnicode() and ucnv_fromUnicode() -
 * are used, "pivoting" through 16-bit Unicode.
 *
 * Important: For streaming conversion (multiple function calls for successive
 * parts of a text stream), the caller must provide a pivot buffer explicitly,
 * and must preserve the pivot buffer and associated pointers from one
 * call to another. (The buffer may be moved if its contents and the relative
 * pointer positions are preserved.)
 *
 * There is a similar function, ucnv_convert(),
 * which has the following limitations:
 * - it takes charset names, not converter objects, so that
 *   - two converters are opened for each call
 *   - only single-string conversion is possible, not streaming operation
 * - it does not provide enough information to find out,
 *   in case of failure, whether the toUnicode or
 *   the fromUnicode conversion failed
 *
 * By contrast, ucnv_convertEx()
 * - takes UConverter parameters instead of charset names
 * - fully exposes the pivot buffer for streaming conversion and complete error handling
 *
 * ucnv_convertEx() also provides further convenience:
 * - an option to reset the converters at the beginning
 *   (if reset==true, see parameters;
 *    also sets *pivotTarget=*pivotSource=pivotStart)
 * - allow NUL-terminated input
 *   (only a single NUL byte, will not work for charsets with multi-byte NULs)
 *   (if sourceLimit==NULL, see parameters)
 * - terminate with a NUL on output
 *   (only a single NUL byte, not useful for charsets with multi-byte NULs),
 *   or set U_STRING_NOT_TERMINATED_WARNING if the output exactly fills
 *   the target buffer
 * - the pivot buffer can be provided internally;
 *   possible only for whole-string conversion, not streaming conversion;
 *   in this case, the caller will not be able to get details about where an
 *   error occurred
 *   (if pivotStart==NULL, see below)
 *
 * The function returns when one of the following is true:
 * - the entire source text has been converted successfully to the target buffer
 * - a target buffer overflow occurred (U_BUFFER_OVERFLOW_ERROR)
 * - a conversion error occurred
 *   (other U_FAILURE(), see description of pErrorCode)
 *
 * Limitation compared to the direct use of
 * ucnv_fromUnicode() and ucnv_toUnicode():
 * ucnv_convertEx() does not provide offset information.
 *
 * Limitation compared to ucnv_fromUChars() and ucnv_toUChars():
 * ucnv_convertEx() does not support preflighting directly.
 *
 * Sample code for converting a single string from
 * one external charset to UTF-8, ignoring the location of errors:
 *
 * \code
 * int32_t
 * myToUTF8(UConverter *cnv,
 *          const char *s, int32_t length,
 *          char *u8, int32_t capacity,
 *          UErrorCode *pErrorCode) {
 *     UConverter *utf8Cnv;
 *     char *target;
 *
 *     if(U_FAILURE(*pErrorCode)) {
 *         return 0;
 *     }
 *
 *     utf8Cnv=myGetCachedUTF8Converter(pErrorCode);
 *     if(U_FAILURE(*pErrorCode)) {
 *         return 0;
 *     }
 *
 *     if(length<0) {
 *         length=strlen(s);
 *     }
 *     target=u8;
 *     ucnv_convertEx(utf8Cnv, cnv,
 *                    &target, u8+capacity,
 *                    &s, s+length,
 *                    NULL, NULL, NULL, NULL,
 *                    true, true,
 *                    pErrorCode);
 *
 *     myReleaseCachedUTF8Converter(utf8Cnv);
 *
 *     // return the output string length, but without preflighting
 *     return (int32_t)(target-u8);
 * }
 * \endcode
 *
 * @param targetCnv     Output converter, used to convert from the UTF-16 pivot
 *                      to the target using ucnv_fromUnicode().
 * @param sourceCnv     Input converter, used to convert from the source to
 *                      the UTF-16 pivot using ucnv_toUnicode().
 * @param target        I/O parameter, same as for ucnv_fromUChars().
 *                      Input: *target points to the beginning of the target buffer.
 *                      Output: *target points to the first unit after the last char written.
 * @param targetLimit   Pointer to the first unit after the target buffer.
 * @param source        I/O parameter, same as for ucnv_toUChars().
 *                      Input: *source points to the beginning of the source buffer.
 *                      Output: *source points to the first unit after the last char read.
 * @param sourceLimit   Pointer to the first unit after the source buffer.
 * @param pivotStart    Pointer to the UTF-16 pivot buffer. If pivotStart==NULL,
 *                      then an internal buffer is used and the other pivot
 *                      arguments are ignored and can be NULL as well.
 * @param pivotSource   I/O parameter, same as source in ucnv_fromUChars() for
 *                      conversion from the pivot buffer to the target buffer.
 * @param pivotTarget   I/O parameter, same as target in ucnv_toUChars() for
 *                      conversion from the source buffer to the pivot buffer.
 *                      It must be pivotStart<=*pivotSource<=*pivotTarget<=pivotLimit
 *                      and pivotStart<pivotLimit (unless pivotStart==NULL).
 * @param pivotLimit    Pointer to the first unit after the pivot buffer.
 * @param reset         If true, then ucnv_resetToUnicode(sourceCnv) and
 *                      ucnv_resetFromUnicode(targetCnv) are called, and the
 *                      pivot pointers are reset (*pivotTarget=*pivotSource=pivotStart).
 * @param flush         If true, indicates the end of the input.
 *                      Passed directly to ucnv_toUnicode(), and carried over to
 *                      ucnv_fromUnicode() when the source is empty as well.
 * @param pErrorCode    ICU error code in/out parameter.
 *                      Must fulfill U_SUCCESS before the function call.
 *                      U_BUFFER_OVERFLOW_ERROR always refers to the target buffer
 *                      because overflows into the pivot buffer are handled internally.
 *                      Other conversion errors are from the source-to-pivot
 *                      conversion if *pivotSource==pivotStart, otherwise from
 *                      the pivot-to-target conversion.
 *
 * @see ucnv_convert
 * @see ucnv_fromAlgorithmic
 * @see ucnv_toAlgorithmic
 * @see ucnv_fromUnicode
 * @see ucnv_toUnicode
 * @see ucnv_fromUChars
 * @see ucnv_toUChars
 * @stable ICU 2.6
 */
U_CAPI void U_EXPORT2
ucnv_convertEx(UConverter *targetCnv, UConverter *sourceCnv,
               char **target, const char *targetLimit,
               const char **source, const char *sourceLimit,
               UChar *pivotStart, UChar **pivotSource,
               UChar **pivotTarget, const UChar *pivotLimit,
               UBool reset, UBool flush,
               UErrorCode *pErrorCode);

/**
 * Convert from one external charset to another.
 * Internally, two converters are opened according to the name arguments,
 * then the text is converted to and from the 16-bit Unicode "pivot"
 * using ucnv_convertEx(), then the converters are closed again.
 *
 * This is a convenience function, not an efficient way to convert a lot of text:
 * ucnv_convert()
 * - takes charset names, not converter objects, so that
 *   - two converters are opened for each call
 *   - only single-string conversion is possible, not streaming operation
 * - does not provide enough information to find out,
 *   in case of failure, whether the toUnicode or
 *   the fromUnicode conversion failed
 * - allows NUL-terminated input
 *   (only a single NUL byte, will not work for charsets with multi-byte NULs)
 *   (if sourceLength==-1, see parameters)
 * - terminate with a NUL on output
 *   (only a single NUL byte, not useful for charsets with multi-byte NULs),
 *   or set U_STRING_NOT_TERMINATED_WARNING if the output exactly fills
 *   the target buffer
 * - a pivot buffer is provided internally
 *
 * The function returns when one of the following is true:
 * - the entire source text has been converted successfully to the target buffer
 *   and either the target buffer is terminated with a single NUL byte
 *   or the error code is set to U_STRING_NOT_TERMINATED_WARNING
 * - a target buffer overflow occurred (U_BUFFER_OVERFLOW_ERROR)
 *   and the full output string length is returned ("preflighting")
 * - a conversion error occurred
 *   (other U_FAILURE(), see description of pErrorCode)
 *
 * @param toConverterName   The name of the converter that is used to convert
 *                          from the UTF-16 pivot buffer to the target.
 * @param fromConverterName The name of the converter that is used to convert
 *                          from the source to the UTF-16 pivot buffer.
 * @param target            Pointer to the output buffer.
 * @param targetCapacity    Capacity of the target, in bytes.
 * @param source            Pointer to the input buffer.
 * @param sourceLength      Length of the input text, in bytes, or -1 for NUL-terminated input.
 * @param pErrorCode        ICU error code in/out parameter.
 *                          Must fulfill U_SUCCESS before the function call.
 * @return Length of the complete output text in bytes, even if it exceeds the targetCapacity
 *         and a U_BUFFER_OVERFLOW_ERROR is set.
 *
 * @see ucnv_convertEx
 * @see ucnv_fromAlgorithmic
 * @see ucnv_toAlgorithmic
 * @see ucnv_fromUnicode
 * @see ucnv_toUnicode
 * @see ucnv_fromUChars
 * @see ucnv_toUChars
 * @see ucnv_getNextUChar
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ucnv_convert(const char *toConverterName,
             const char *fromConverterName,
             char *target,
             int32_t targetCapacity,
             const char *source,
             int32_t sourceLength,
             UErrorCode *pErrorCode);

/**
 * Convert from one external charset to another.
 * Internally, the text is converted to and from the 16-bit Unicode "pivot"
 * using ucnv_convertEx(). ucnv_toAlgorithmic() works exactly like ucnv_convert()
 * except that the two converters need not be looked up and opened completely.
 *
 * The source-to-pivot conversion uses the cnv converter parameter.
 * The pivot-to-target conversion uses a purely algorithmic converter
 * according to the specified type, e.g., UCNV_UTF8 for a UTF-8 converter.
 *
 * Internally, the algorithmic converter is opened and closed for each
 * function call, which is more efficient than using the public ucnv_open()
 * but somewhat less efficient than only resetting an existing converter
 * and using ucnv_convertEx().
 *
 * This function is more convenient than ucnv_convertEx() for single-string
 * conversions, especially when "preflighting" is desired (returning the length
 * of the complete output even if it does not fit into the target buffer;
 * see the User Guide Strings chapter). See ucnv_convert() for details.
 *
 * @param algorithmicType   UConverterType constant identifying the desired target
 *                          charset as a purely algorithmic converter.
 *                          Those are converters for Unicode charsets like
 *                          UTF-8, BOCU-1, SCSU, UTF-7, IMAP-mailbox-name, etc.,
 *                          as well as US-ASCII and ISO-8859-1.
 * @param cnv               The converter that is used to convert
 *                          from the source to the UTF-16 pivot buffer.
 * @param target            Pointer to the output buffer.
 * @param targetCapacity    Capacity of the target, in bytes.
 * @param source            Pointer to the input buffer.
 * @param sourceLength      Length of the input text, in bytes
 * @param pErrorCode        ICU error code in/out parameter.
 *                          Must fulfill U_SUCCESS before the function call.
 * @return Length of the complete output text in bytes, even if it exceeds the targetCapacity
 *         and a U_BUFFER_OVERFLOW_ERROR is set.
 *
 * @see ucnv_fromAlgorithmic
 * @see ucnv_convert
 * @see ucnv_convertEx
 * @see ucnv_fromUnicode
 * @see ucnv_toUnicode
 * @see ucnv_fromUChars
 * @see ucnv_toUChars
 * @stable ICU 2.6
 */
U_CAPI int32_t U_EXPORT2
ucnv_toAlgorithmic(UConverterType algorithmicType,
                   UConverter *cnv,
                   char *target, int32_t targetCapacity,
                   const char *source, int32_t sourceLength,
                   UErrorCode *pErrorCode);

/**
 * Convert from one external charset to another.
 * Internally, the text is converted to and from the 16-bit Unicode "pivot"
 * using ucnv_convertEx(). ucnv_fromAlgorithmic() works exactly like ucnv_convert()
 * except that the two converters need not be looked up and opened completely.
 *
 * The source-to-pivot conversion uses a purely algorithmic converter
 * according to the specified type, e.g., UCNV_UTF8 for a UTF-8 converter.
 * The pivot-to-target conversion uses the cnv converter parameter.
 *
 * Internally, the algorithmic converter is opened and closed for each
 * function call, which is more efficient than using the public ucnv_open()
 * but somewhat less efficient than only resetting an existing converter
 * and using ucnv_convertEx().
 *
 * This function is more convenient than ucnv_convertEx() for single-string
 * conversions, especially when "preflighting" is desired (returning the length
 * of the complete output even if it does not fit into the target buffer;
 * see the User Guide Strings chapter). See ucnv_convert() for details.
 *
 * @param cnv               The converter that is used to convert
 *                          from the UTF-16 pivot buffer to the target.
 * @param algorithmicType   UConverterType constant identifying the desired source
 *                          charset as a purely algorithmic converter.
 *                          Those are converters for Unicode charsets like
 *                          UTF-8, BOCU-1, SCSU, UTF-7, IMAP-mailbox-name, etc.,
 *                          as well as US-ASCII and ISO-8859-1.
 * @param target            Pointer to the output buffer.
 * @param targetCapacity    Capacity of the target, in bytes.
 * @param source            Pointer to the input buffer.
 * @param sourceLength      Length of the input text, in bytes
 * @param pErrorCode        ICU error code in/out parameter.
 *                          Must fulfill U_SUCCESS before the function call.
 * @return Length of the complete output text in bytes, even if it exceeds the targetCapacity
 *         and a U_BUFFER_OVERFLOW_ERROR is set.
 *
 * @see ucnv_fromAlgorithmic
 * @see ucnv_convert
 * @see ucnv_convertEx
 * @see ucnv_fromUnicode
 * @see ucnv_toUnicode
 * @see ucnv_fromUChars
 * @see ucnv_toUChars
 * @stable ICU 2.6
 */
U_CAPI int32_t U_EXPORT2
ucnv_fromAlgorithmic(UConverter *cnv,
                     UConverterType algorithmicType,
                     char *target, int32_t targetCapacity,
                     const char *source, int32_t sourceLength,
                     UErrorCode *pErrorCode);

/**
 * Frees up memory occupied by unused, cached converter shared data.
 *
 * @return the number of cached converters successfully deleted
 * @see ucnv_close
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ucnv_flushCache(void);

/**
 * Returns the number of available converters, as per the alias file.
 *
 * @return the number of available converters
 * @see ucnv_getAvailableName
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2
ucnv_countAvailable(void);

/**
 * Gets the canonical converter name of the specified converter from a list of
 * all available converters contained in the alias file. All converters
 * in this list can be opened.
 *
 * @param n the index to a converter available on the system (in the range <TT>[0..ucnv_countAvailable()]</TT>)
 * @return a pointer a string (library owned), or <TT>NULL</TT> if the index is out of bounds.
 * @see ucnv_countAvailable
 * @stable ICU 2.0
 */
U_CAPI const char* U_EXPORT2
ucnv_getAvailableName(int32_t n);

/**
 * Returns a UEnumeration to enumerate all of the canonical converter
 * names, as per the alias file, regardless of the ability to open each
 * converter.
 *
 * @return A UEnumeration object for getting all the recognized canonical
 *   converter names.
 * @see ucnv_getAvailableName
 * @see uenum_close
 * @see uenum_next
 * @stable ICU 2.4
 */
U_CAPI UEnumeration * U_EXPORT2
ucnv_openAllNames(UErrorCode *pErrorCode);

/**
 * Gives the number of aliases for a given converter or alias name.
 * If the alias is ambiguous, then the preferred converter is used
 * and the status is set to U_AMBIGUOUS_ALIAS_WARNING.
 * This method only enumerates the listed entries in the alias file.
 * @param alias alias name
 * @param pErrorCode error status
 * @return number of names on alias list for given alias
 * @stable ICU 2.0
 */
U_CAPI uint16_t U_EXPORT2
ucnv_countAliases(const char *alias, UErrorCode *pErrorCode);

/**
 * Gives the name of the alias at given index of alias list.
 * This method only enumerates the listed entries in the alias file.
 * If the alias is ambiguous, then the preferred converter is used
 * and the status is set to U_AMBIGUOUS_ALIAS_WARNING.
 * @param alias alias name
 * @param n index in alias list
 * @param pErrorCode result of operation
 * @return returns the name of the alias at given index
 * @see ucnv_countAliases
 * @stable ICU 2.0
 */
U_CAPI const char * U_EXPORT2
ucnv_getAlias(const char *alias, uint16_t n, UErrorCode *pErrorCode);

/**
 * Fill-up the list of alias names for the given alias.
 * This method only enumerates the listed entries in the alias file.
 * If the alias is ambiguous, then the preferred converter is used
 * and the status is set to U_AMBIGUOUS_ALIAS_WARNING.
 * @param alias alias name
 * @param aliases fill-in list, aliases is a pointer to an array of
 *        <code>ucnv_countAliases()</code> string-pointers
 *        (<code>const char *</code>) that will be filled in.
 *        The strings themselves are owned by the library.
 * @param pErrorCode result of operation
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_getAliases(const char *alias, const char **aliases, UErrorCode *pErrorCode);

/**
 * Return a new UEnumeration object for enumerating all the
 * alias names for a given converter that are recognized by a standard.
 * This method only enumerates the listed entries in the alias file.
 * The convrtrs.txt file can be modified to change the results of
 * this function.
 * The first result in this list is the same result given by
 * <code>ucnv_getStandardName</code>, which is the default alias for
 * the specified standard name. The returned object must be closed with
 * <code>uenum_close</code> when you are done with the object.
 *
 * @param convName original converter name
 * @param standard name of the standard governing the names; MIME and IANA
 *      are such standards
 * @param pErrorCode The error code
 * @return A UEnumeration object for getting all aliases that are recognized
 *      by a standard. If any of the parameters are invalid, NULL
 *      is returned.
 * @see ucnv_getStandardName
 * @see uenum_close
 * @see uenum_next
 * @stable ICU 2.2
 */
U_CAPI UEnumeration * U_EXPORT2
ucnv_openStandardNames(const char *convName,
                       const char *standard,
                       UErrorCode *pErrorCode);

/**
 * Gives the number of standards associated to converter names.
 * @return number of standards
 * @stable ICU 2.0
 */
U_CAPI uint16_t U_EXPORT2
ucnv_countStandards(void);

/**
 * Gives the name of the standard at given index of standard list.
 * @param n index in standard list
 * @param pErrorCode result of operation
 * @return returns the name of the standard at given index. Owned by the library.
 * @stable ICU 2.0
 */
U_CAPI const char * U_EXPORT2
ucnv_getStandard(uint16_t n, UErrorCode *pErrorCode);

/**
 * Returns a standard name for a given converter name.
 * <p>
 * Example alias table:<br>
 * conv alias1 { STANDARD1 } alias2 { STANDARD1* }
 * <p>
 * Result of ucnv_getStandardName("conv", "STANDARD1") from example
 * alias table:<br>
 * <b>"alias2"</b>
 *
 * @param name original converter name
 * @param standard name of the standard governing the names; MIME and IANA
 *        are such standards
 * @param pErrorCode result of operation
 * @return returns the standard converter name;
 *         if a standard converter name cannot be determined,
 *         then <code>NULL</code> is returned. Owned by the library.
 * @stable ICU 2.0
 */
U_CAPI const char * U_EXPORT2
ucnv_getStandardName(const char *name, const char *standard, UErrorCode *pErrorCode);

/**
 * This function will return the internal canonical converter name of the
 * tagged alias. This is the opposite of ucnv_openStandardNames, which
 * returns the tagged alias given the canonical name.
 * <p>
 * Example alias table:<br>
 * conv alias1 { STANDARD1 } alias2 { STANDARD1* }
 * <p>
 * Result of ucnv_getStandardName("alias1", "STANDARD1") from example
 * alias table:<br>
 * <b>"conv"</b>
 *
 * @return returns the canonical converter name;
 *         if a standard or alias name cannot be determined,
 *         then <code>NULL</code> is returned. The returned string is
 *         owned by the library.
 * @see ucnv_getStandardName
 * @stable ICU 2.4
 */
U_CAPI const char * U_EXPORT2
ucnv_getCanonicalName(const char *alias, const char *standard, UErrorCode *pErrorCode);

/**
 * Returns the current default converter name. If you want to open
 * a default converter, you do not need to use this function.
 * It is faster if you pass a NULL argument to ucnv_open the
 * default converter.
 *
 * If U_CHARSET_IS_UTF8 is defined to 1 in utypes.h then this function
 * always returns "UTF-8".
 *
 * @return returns the current default converter name.
 *         Storage owned by the library
 * @see ucnv_setDefaultName
 * @stable ICU 2.0
 */
U_CAPI const char * U_EXPORT2
ucnv_getDefaultName(void);

#ifndef U_HIDE_SYSTEM_API
/**
 * This function is not thread safe. DO NOT call this function when ANY ICU
 * function is being used from more than one thread! This function sets the
 * current default converter name. If this function needs to be called, it
 * should be called during application initialization. Most of the time, the
 * results from ucnv_getDefaultName() or ucnv_open with a NULL string argument
 * is sufficient for your application.
 *
 * If U_CHARSET_IS_UTF8 is defined to 1 in utypes.h then this function
 * does nothing.
 *
 * @param name the converter name to be the default (must be known by ICU).
 * @see ucnv_getDefaultName
 * @system
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_setDefaultName(const char *name);
#endif  /* U_HIDE_SYSTEM_API */

/**
 * Fixes the backslash character mismapping.  For example, in SJIS, the backslash
 * character in the ASCII portion is also used to represent the yen currency sign.
 * When mapping from Unicode character 0x005C, it's unclear whether to map the
 * character back to yen or backslash in SJIS.  This function will take the input
 * buffer and replace all the yen sign characters with backslash.  This is necessary
 * when the user tries to open a file with the input buffer on Windows.
 * This function will test the converter to see whether such mapping is
 * required.  You can sometimes avoid using this function by using the correct version
 * of Shift-JIS.
 *
 * @param cnv The converter representing the target codepage.
 * @param source the input buffer to be fixed
 * @param sourceLen the length of the input buffer
 * @see ucnv_isAmbiguous
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2
ucnv_fixFileSeparator(const UConverter *cnv, UChar *source, int32_t sourceLen);

/**
 * Determines if the converter contains ambiguous mappings of the same
 * character or not.
 * @param cnv the converter to be tested
 * @return true if the converter contains ambiguous mapping of the same
 * character, false otherwise.
 * @stable ICU 2.0
 */
U_CAPI UBool U_EXPORT2
ucnv_isAmbiguous(const UConverter *cnv);

/**
 * Sets the converter to use fallback mappings or not.
 * Regardless of this flag, the converter will always use
 * fallbacks from Unicode Private Use code points, as well as
 * reverse fallbacks (to Unicode).
 * For details see ".ucm File Format"
 * in the Conversion Data chapter of the ICU User Guide:
 * https://unicode-org.github.io/icu/userguide/conversion/data.html#ucm-file-format
 *
 * @param cnv The converter to set the fallback mapping usage on.
 * @param usesFallback true if the user wants the converter to take advantage of the fallback
 * mapping, false otherwise.
 * @stable ICU 2.0
 * @see ucnv_usesFallback
 */
U_CAPI void U_EXPORT2
ucnv_setFallback(UConverter *cnv, UBool usesFallback);

/**
 * Determines if the converter uses fallback mappings or not.
 * This flag has restrictions, see ucnv_setFallback().
 *
 * @param cnv The converter to be tested
 * @return true if the converter uses fallback, false otherwise.
 * @stable ICU 2.0
 * @see ucnv_setFallback
 */
U_CAPI UBool U_EXPORT2
ucnv_usesFallback(const UConverter *cnv);

/**
 * Detects Unicode signature byte sequences at the start of the byte stream
 * and returns the charset name of the indicated Unicode charset.
 * NULL is returned when no Unicode signature is recognized.
 * The number of bytes in the signature is output as well.
 *
 * The caller can ucnv_open() a converter using the charset name.
 * The first code unit (UChar) from the start of the stream will be U+FEFF
 * (the Unicode BOM/signature character) and can usually be ignored.
 *
 * For most Unicode charsets it is also possible to ignore the indicated
 * number of initial stream bytes and start converting after them.
 * However, there are stateful Unicode charsets (UTF-7 and BOCU-1) for which
 * this will not work. Therefore, it is best to ignore the first output UChar
 * instead of the input signature bytes.
 * <p>
 * Usage:
 *
 * @param source            The source string in which the signature should be detected.
 * @param sourceLength      Length of the input string, or -1 if terminated with a NUL byte.
 * @param signatureLength   A pointer to int32_t to receive the number of bytes that make up the signature
 *                          of the detected UTF. 0 if not detected.
 *                          Can be a NULL pointer.
 * @param pErrorCode        ICU error code in/out parameter.
 *                          Must fulfill U_SUCCESS before the function call.
 * @return The name of the encoding detected. NULL if encoding is not detected.
 * @stable ICU 2.4
 */
U_CAPI const char* U_EXPORT2
ucnv_detectUnicodeSignature(const char* source,
                            int32_t sourceLength,
                            int32_t *signatureLength,
                            UErrorCode *pErrorCode);

/**
 * Returns the number of UChars held in the converter's internal state
 * because more input is needed for completing the conversion. This function is
 * useful for mapping semantics of ICU's converter interface to those of iconv,
 * and this information is not needed for normal conversion.
 * @param cnv       The converter in which the input is held
 * @param status    ICU error code in/out parameter.
 *                  Must fulfill U_SUCCESS before the function call.
 * @return The number of UChars in the state. -1 if an error is encountered.
 * @stable ICU 3.4
 */
U_CAPI int32_t U_EXPORT2
ucnv_fromUCountPending(const UConverter* cnv, UErrorCode* status);

/**
 * Returns the number of chars held in the converter's internal state
 * because more input is needed for completing the conversion. This function is
 * useful for mapping semantics of ICU's converter interface to those of iconv,
 * and this information is not needed for normal conversion.
 * @param cnv       The converter in which the input is held as internal state
 * @param status    ICU error code in/out parameter.
 *                  Must fulfill U_SUCCESS before the function call.
 * @return The number of chars in the state. -1 if an error is encountered.
 * @stable ICU 3.4
 */
U_CAPI int32_t U_EXPORT2
ucnv_toUCountPending(const UConverter* cnv, UErrorCode* status);

/**
 * Returns whether or not the charset of the converter has a fixed number of bytes
 * per charset character.
 * An example of this are converters that are of the type UCNV_SBCS or UCNV_DBCS.
 * Another example is UTF-32 which is always 4 bytes per character.
 * A Unicode code point may be represented by more than one UTF-8 or UTF-16 code unit
 * but a UTF-32 converter encodes each code point with 4 bytes.
 * Note: This method is not intended to be used to determine whether the charset has a
 * fixed ratio of bytes to Unicode codes <i>units</i> for any particular Unicode encoding form.
 * false is returned with the UErrorCode if error occurs or cnv is NULL.
 * @param cnv       The converter to be tested
 * @param status    ICU error code in/out parameter
 * @return true if the converter is fixed-width
 * @stable ICU 4.8
 */
U_CAPI UBool U_EXPORT2
ucnv_isFixedWidth(UConverter *cnv, UErrorCode *status);

#endif

#endif
/*_UCNV*/
