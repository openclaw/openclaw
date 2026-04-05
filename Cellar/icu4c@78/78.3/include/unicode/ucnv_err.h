// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (C) 1999-2009, International Business Machines
*   Corporation and others.  All Rights Reserved.
**********************************************************************
 *
 *
 *   ucnv_err.h:
 */

/**
 * \file
 * \brief C API: UConverter predefined error callbacks
 *
 *  <h2>Error Behaviour Functions</h2>
 *  Defines some error behaviour functions called by ucnv_{from,to}Unicode
 *  These are provided as part of ICU and many are stable, but they
 *  can also be considered only as an example of what can be done with
 *  callbacks.  You may of course write your own.
 *
 *  If you want to write your own, you may also find the functions from
 *  ucnv_cb.h useful when writing your own callbacks.
 *
 *  These functions, although public, should NEVER be called directly.
 *  They should be used as parameters to the ucnv_setFromUCallback
 *  and ucnv_setToUCallback functions, to set the behaviour of a converter
 *  when it encounters ILLEGAL/UNMAPPED/INVALID sequences.
 *
 *  usage example:  'STOP' doesn't need any context, but newContext
 *    could be set to something other than 'NULL' if needed. The available
 *    contexts in this header can modify the default behavior of the callback.
 *
 *  \code
 *  UErrorCode err = U_ZERO_ERROR;
 *  UConverter *myConverter = ucnv_open("ibm-949", &err);
 *  const void *oldContext;
 *  UConverterFromUCallback oldAction;
 *
 *
 *  if (U_SUCCESS(err))
 *  {
 *      ucnv_setFromUCallBack(myConverter,
 *                       UCNV_FROM_U_CALLBACK_STOP,
 *                       NULL,
 *                       &oldAction,
 *                       &oldContext,
 *                       &status);
 *  }
 *  \endcode
 *
 *  The code above tells "myConverter" to stop when it encounters an
 *  ILLEGAL/TRUNCATED/INVALID sequences when it is used to convert from
 *  Unicode -> Codepage. The behavior from Codepage to Unicode is not changed,
 *  and ucnv_setToUCallBack would need to be called in order to change
 *  that behavior too.
 *
 *  Here is an example with a context:
 *
 *  \code
 *  UErrorCode err = U_ZERO_ERROR;
 *  UConverter *myConverter = ucnv_open("ibm-949", &err);
 *  const void *oldContext;
 *  UConverterFromUCallback oldAction;
 *
 *
 *  if (U_SUCCESS(err))
 *  {
 *      ucnv_setToUCallBack(myConverter,
 *                       UCNV_TO_U_CALLBACK_SUBSTITUTE,
 *                       UCNV_SUB_STOP_ON_ILLEGAL,
 *                       &oldAction,
 *                       &oldContext,
 *                       &status);
 *  }
 *  \endcode
 *
 *  The code above tells "myConverter" to stop when it encounters an
 *  ILLEGAL/TRUNCATED/INVALID sequences when it is used to convert from
 *  Codepage -> Unicode. Any unmapped and legal characters will be
 *  substituted to be the default substitution character.
 */

#ifndef UCNV_ERR_H
#define UCNV_ERR_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_CONVERSION

/** Forward declaring the UConverter structure. @stable ICU 2.0 */
struct UConverter;

/** @stable ICU 2.0 */
typedef struct UConverter UConverter;

/**
 * FROM_U, TO_U context options for sub callback
 * @stable ICU 2.0
 */
#define UCNV_SUB_STOP_ON_ILLEGAL "i"

/**
 * FROM_U, TO_U context options for skip callback
 * @stable ICU 2.0
 */
#define UCNV_SKIP_STOP_ON_ILLEGAL "i"

/**
 * FROM_U_CALLBACK_ESCAPE context option to escape the code unit according to ICU (%UXXXX) 
 * @stable ICU 2.0
 */
#define UCNV_ESCAPE_ICU       NULL
/**
 * FROM_U_CALLBACK_ESCAPE context option to escape the code unit according to JAVA (\\uXXXX)
 * @stable ICU 2.0
 */
#define UCNV_ESCAPE_JAVA      "J"
/**
 * FROM_U_CALLBACK_ESCAPE context option to escape the code unit according to C (\\uXXXX \\UXXXXXXXX)
 * TO_U_CALLBACK_ESCAPE option to escape the character value according to C (\\xXXXX)
 * @stable ICU 2.0
 */
#define UCNV_ESCAPE_C         "C"
/**
 * FROM_U_CALLBACK_ESCAPE context option to escape the code unit according to XML Decimal escape \htmlonly(&amp;#DDDD;)\endhtmlonly
 * TO_U_CALLBACK_ESCAPE context option to escape the character value according to XML Decimal escape \htmlonly(&amp;#DDDD;)\endhtmlonly
 * @stable ICU 2.0
 */
#define UCNV_ESCAPE_XML_DEC   "D"
/**
 * FROM_U_CALLBACK_ESCAPE context option to escape the code unit according to XML Hex escape \htmlonly(&amp;#xXXXX;)\endhtmlonly
 * TO_U_CALLBACK_ESCAPE context option to escape the character value according to XML Hex escape \htmlonly(&amp;#xXXXX;)\endhtmlonly
 * @stable ICU 2.0
 */
#define UCNV_ESCAPE_XML_HEX   "X"
/**
 * FROM_U_CALLBACK_ESCAPE context option to escape the code unit according to Unicode (U+XXXXX)
 * @stable ICU 2.0
 */
#define UCNV_ESCAPE_UNICODE   "U"

/**
 * FROM_U_CALLBACK_ESCAPE context option to escape the code unit according to CSS2 conventions (\\HH..H<space>, that is,
 * a backslash, 1..6 hex digits, and a space)
 * @stable ICU 4.0
 */
#define UCNV_ESCAPE_CSS2   "S"

/** 
 * The process condition code to be used with the callbacks.  
 * Codes which are greater than UCNV_IRREGULAR should be 
 * passed on to any chained callbacks.
 * @stable ICU 2.0
 */
typedef enum {
    UCNV_UNASSIGNED = 0,  /**< The code point is unassigned.
                             The error code U_INVALID_CHAR_FOUND will be set. */
    UCNV_ILLEGAL = 1,     /**< The code point is illegal. For example, 
                             \\x81\\x2E is illegal in SJIS because \\x2E
                             is not a valid trail byte for the \\x81 
                             lead byte.
                             Also, starting with Unicode 3.0.1, non-shortest byte sequences
                             in UTF-8 (like \\xC1\\xA1 instead of \\x61 for U+0061)
                             are also illegal, not just irregular.
                             The error code U_ILLEGAL_CHAR_FOUND will be set. */
    UCNV_IRREGULAR = 2,   /**< The codepoint is not a regular sequence in 
                             the encoding. For example, \\xED\\xA0\\x80..\\xED\\xBF\\xBF
                             are irregular UTF-8 byte sequences for single surrogate
                             code points.
                             The error code U_INVALID_CHAR_FOUND will be set. */
    UCNV_RESET = 3,       /**< The callback is called with this reason when a
                             'reset' has occurred. Callback should reset all
                             state. */
    UCNV_CLOSE = 4,        /**< Called when the converter is closed. The
                             callback should release any allocated memory.*/
    UCNV_CLONE = 5         /**< Called when ucnv_safeClone() is called on the
                              converter. the pointer available as the
                              'context' is an alias to the original converters'
                              context pointer. If the context must be owned
                              by the new converter, the callback must clone 
                              the data and call ucnv_setFromUCallback 
                              (or setToUCallback) with the correct pointer.
                              @stable ICU 2.2
                           */
} UConverterCallbackReason;


/**
 * The structure for the fromUnicode callback function parameter.
 * @stable ICU 2.0
 */
typedef struct {
    uint16_t size;              /**< The size of this struct. @stable ICU 2.0 */
    UBool flush;                /**< The internal state of converter will be reset and data flushed if set to true. @stable ICU 2.0    */
    UConverter *converter;      /**< Pointer to the converter that is opened and to which this struct is passed as an argument. @stable ICU 2.0  */
    const UChar *source;        /**< Pointer to the source source buffer. @stable ICU 2.0    */
    const UChar *sourceLimit;   /**< Pointer to the limit (end + 1) of source buffer. @stable ICU 2.0    */
    char *target;               /**< Pointer to the target buffer. @stable ICU 2.0    */
    const char *targetLimit;    /**< Pointer to the limit (end + 1) of target buffer. @stable ICU 2.0     */
    int32_t *offsets;           /**< Pointer to the buffer that receives the offsets. *offset = blah ; offset++;. @stable ICU 2.0  */
} UConverterFromUnicodeArgs;


/**
 * The structure for the toUnicode callback function parameter.
 * @stable ICU 2.0
 */
typedef struct {
    uint16_t size;              /**< The size of this struct   @stable ICU 2.0 */
    UBool flush;                /**< The internal state of converter will be reset and data flushed if set to true. @stable ICU 2.0   */
    UConverter *converter;      /**< Pointer to the converter that is opened and to which this struct is passed as an argument. @stable ICU 2.0 */
    const char *source;         /**< Pointer to the source source buffer. @stable ICU 2.0    */
    const char *sourceLimit;    /**< Pointer to the limit (end + 1) of source buffer. @stable ICU 2.0    */
    UChar *target;              /**< Pointer to the target buffer. @stable ICU 2.0    */
    const UChar *targetLimit;   /**< Pointer to the limit (end + 1) of target buffer. @stable ICU 2.0     */
    int32_t *offsets;           /**< Pointer to the buffer that receives the offsets. *offset = blah ; offset++;. @stable ICU 2.0  */
} UConverterToUnicodeArgs;


/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This From Unicode callback STOPS at the ILLEGAL_SEQUENCE,
 * returning the error code back to the caller immediately.
 *
 * @param context Pointer to the callback's private data
 * @param fromUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' UChars of the concerned Unicode sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param codePoint Single UChar32 (UTF-32) containing the concerend Unicode codepoint.
 * @param reason Defines the reason the callback was invoked
 * @param err This should always be set to a failure status prior to calling.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 UCNV_FROM_U_CALLBACK_STOP (
                  const void *context,
                  UConverterFromUnicodeArgs *fromUArgs,
                  const UChar* codeUnits,
                  int32_t length,
                  UChar32 codePoint,
                  UConverterCallbackReason reason,
                  UErrorCode * err);



/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This To Unicode callback STOPS at the ILLEGAL_SEQUENCE,
 * returning the error code back to the caller immediately.
 *
 * @param context Pointer to the callback's private data
 * @param toUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' bytes of the concerned codepage sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param reason Defines the reason the callback was invoked
 * @param err This should always be set to a failure status prior to calling.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 UCNV_TO_U_CALLBACK_STOP (
                  const void *context,
                  UConverterToUnicodeArgs *toUArgs,
                  const char* codeUnits,
                  int32_t length,
                  UConverterCallbackReason reason,
                  UErrorCode * err);

/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This From Unicode callback skips any ILLEGAL_SEQUENCE, or
 * skips only UNASSIGNED_SEQUENCE depending on the context parameter
 * simply ignoring those characters. 
 *
 * @param context  The function currently recognizes the callback options:
 *                 UCNV_SKIP_STOP_ON_ILLEGAL: STOPS at the ILLEGAL_SEQUENCE,
 *                      returning the error code back to the caller immediately.
 *                 NULL: Skips any ILLEGAL_SEQUENCE
 * @param fromUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' UChars of the concerned Unicode sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param codePoint Single UChar32 (UTF-32) containing the concerend Unicode codepoint.
 * @param reason Defines the reason the callback was invoked
 * @param err Return value will be set to success if the callback was handled,
 *      otherwise this value will be set to a failure status.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 UCNV_FROM_U_CALLBACK_SKIP (
                  const void *context,
                  UConverterFromUnicodeArgs *fromUArgs,
                  const UChar* codeUnits,
                  int32_t length,
                  UChar32 codePoint,
                  UConverterCallbackReason reason,
                  UErrorCode * err);

/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This From Unicode callback will Substitute the ILLEGAL SEQUENCE, or 
 * UNASSIGNED_SEQUENCE depending on context parameter, with the
 * current substitution string for the converter. This is the default
 * callback.
 *
 * @param context The function currently recognizes the callback options:
 *                 UCNV_SUB_STOP_ON_ILLEGAL: STOPS at the ILLEGAL_SEQUENCE,
 *                      returning the error code back to the caller immediately.
 *                 NULL: Substitutes any ILLEGAL_SEQUENCE
 * @param fromUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' UChars of the concerned Unicode sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param codePoint Single UChar32 (UTF-32) containing the concerend Unicode codepoint.
 * @param reason Defines the reason the callback was invoked
 * @param err Return value will be set to success if the callback was handled,
 *      otherwise this value will be set to a failure status.
 * @see ucnv_setSubstChars
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 UCNV_FROM_U_CALLBACK_SUBSTITUTE (
                  const void *context,
                  UConverterFromUnicodeArgs *fromUArgs,
                  const UChar* codeUnits,
                  int32_t length,
                  UChar32 codePoint,
                  UConverterCallbackReason reason,
                  UErrorCode * err);

/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This From Unicode callback will Substitute the ILLEGAL SEQUENCE with the
 * hexadecimal representation of the illegal codepoints
 *
 * @param context The function currently recognizes the callback options:
 *        <ul>
 *        <li>UCNV_ESCAPE_ICU: Substitutes the  ILLEGAL SEQUENCE with the hexadecimal 
 *          representation in the format  %UXXXX, e.g. "%uFFFE%u00AC%uC8FE"). 
 *          In the Event the converter doesn't support the characters {%,U}[A-F][0-9], 
 *          it will  substitute  the illegal sequence with the substitution characters.
 *          Note that  codeUnit(32bit int eg: unit of a surrogate pair) is represented as
 *          %UD84D%UDC56</li>
 *        <li>UCNV_ESCAPE_JAVA: Substitutes the  ILLEGAL SEQUENCE with the hexadecimal 
 *          representation in the format  \\uXXXX, e.g. "\\uFFFE\\u00AC\\uC8FE"). 
 *          In the Event the converter doesn't support the characters {\,u}[A-F][0-9], 
 *          it will  substitute  the illegal sequence with the substitution characters.
 *          Note that  codeUnit(32bit int eg: unit of a surrogate pair) is represented as
 *          \\uD84D\\uDC56</li>
 *        <li>UCNV_ESCAPE_C: Substitutes the  ILLEGAL SEQUENCE with the hexadecimal 
 *          representation in the format  \\uXXXX, e.g. "\\uFFFE\\u00AC\\uC8FE"). 
 *          In the Event the converter doesn't support the characters {\,u,U}[A-F][0-9], 
 *          it will  substitute  the illegal sequence with the substitution characters.
 *          Note that  codeUnit(32bit int eg: unit of a surrogate pair) is represented as
 *          \\U00023456</li>
 *        <li>UCNV_ESCAPE_XML_DEC: Substitutes the  ILLEGAL SEQUENCE with the decimal 
 *          representation in the format \htmlonly&amp;#DDDDDDDD;, e.g. "&amp;#65534;&amp;#172;&amp;#51454;")\endhtmlonly. 
 *          In the Event the converter doesn't support the characters {&amp;,#}[0-9], 
 *          it will  substitute  the illegal sequence with the substitution characters.
 *          Note that  codeUnit(32bit int eg: unit of a surrogate pair) is represented as
 *          &amp;#144470; and Zero padding is ignored.</li>
 *        <li>UCNV_ESCAPE_XML_HEX:Substitutes the  ILLEGAL SEQUENCE with the decimal 
 *          representation in the format \htmlonly&amp;#xXXXX; e.g. "&amp;#xFFFE;&amp;#x00AC;&amp;#xC8FE;")\endhtmlonly. 
 *          In the Event the converter doesn't support the characters {&,#,x}[0-9], 
 *          it will  substitute  the illegal sequence with the substitution characters.
 *          Note that  codeUnit(32bit int eg: unit of a surrogate pair) is represented as
 *          \htmlonly&amp;#x23456;\endhtmlonly</li>
 *        </ul>
 * @param fromUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' UChars of the concerned Unicode sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param codePoint Single UChar32 (UTF-32) containing the concerend Unicode codepoint.
 * @param reason Defines the reason the callback was invoked
 * @param err Return value will be set to success if the callback was handled,
 *      otherwise this value will be set to a failure status.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 UCNV_FROM_U_CALLBACK_ESCAPE (
                  const void *context,
                  UConverterFromUnicodeArgs *fromUArgs,
                  const UChar* codeUnits,
                  int32_t length,
                  UChar32 codePoint,
                  UConverterCallbackReason reason,
                  UErrorCode * err);


/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This To Unicode callback skips any ILLEGAL_SEQUENCE, or
 * skips only UNASSIGNED_SEQUENCE depending on the context parameter
 * simply ignoring those characters. 
 *
 * @param context  The function currently recognizes the callback options:
 *                 UCNV_SKIP_STOP_ON_ILLEGAL: STOPS at the ILLEGAL_SEQUENCE,
 *                      returning the error code back to the caller immediately.
 *                 NULL: Skips any ILLEGAL_SEQUENCE
 * @param toUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' bytes of the concerned codepage sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param reason Defines the reason the callback was invoked
 * @param err Return value will be set to success if the callback was handled,
 *      otherwise this value will be set to a failure status.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 UCNV_TO_U_CALLBACK_SKIP (
                  const void *context,
                  UConverterToUnicodeArgs *toUArgs,
                  const char* codeUnits,
                  int32_t length,
                  UConverterCallbackReason reason,
                  UErrorCode * err);

/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This To Unicode callback will Substitute the ILLEGAL SEQUENCE,or 
 * UNASSIGNED_SEQUENCE depending on context parameter,  with the
 * Unicode substitution character, U+FFFD.
 *
 * @param context  The function currently recognizes the callback options:
 *                 UCNV_SUB_STOP_ON_ILLEGAL: STOPS at the ILLEGAL_SEQUENCE,
 *                      returning the error code back to the caller immediately.
 *                 NULL: Substitutes any ILLEGAL_SEQUENCE
 * @param toUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' bytes of the concerned codepage sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param reason Defines the reason the callback was invoked
 * @param err Return value will be set to success if the callback was handled,
 *      otherwise this value will be set to a failure status.
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 UCNV_TO_U_CALLBACK_SUBSTITUTE (
                  const void *context,
                  UConverterToUnicodeArgs *toUArgs,
                  const char* codeUnits,
                  int32_t length,
                  UConverterCallbackReason reason,
                  UErrorCode * err);

/**
 * DO NOT CALL THIS FUNCTION DIRECTLY!
 * This To Unicode callback will Substitute the ILLEGAL SEQUENCE with the
 * hexadecimal representation of the illegal bytes
 *  (in the format  %XNN, e.g. "%XFF%X0A%XC8%X03").
 *
 * @param context This function currently recognizes the callback options:
 *      UCNV_ESCAPE_ICU, UCNV_ESCAPE_JAVA, UCNV_ESCAPE_C, UCNV_ESCAPE_XML_DEC,
 *      UCNV_ESCAPE_XML_HEX and UCNV_ESCAPE_UNICODE.
 * @param toUArgs Information about the conversion in progress
 * @param codeUnits Points to 'length' bytes of the concerned codepage sequence
 * @param length Size (in bytes) of the concerned codepage sequence
 * @param reason Defines the reason the callback was invoked
 * @param err Return value will be set to success if the callback was handled,
 *      otherwise this value will be set to a failure status.
 * @stable ICU 2.0
 */

U_CAPI void U_EXPORT2 UCNV_TO_U_CALLBACK_ESCAPE (
                  const void *context,
                  UConverterToUnicodeArgs *toUArgs,
                  const char* codeUnits,
                  int32_t length,
                  UConverterCallbackReason reason,
                  UErrorCode * err);

#endif

#endif

/*UCNV_ERR_H*/ 
