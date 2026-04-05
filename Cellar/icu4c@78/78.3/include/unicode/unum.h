// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 1997-2015, International Business Machines Corporation and others.
* All Rights Reserved.
* Modification History:
*
*   Date        Name        Description
*   06/24/99    helena      Integrated Alan's NF enhancements and Java2 bug fixes
*******************************************************************************
*/

#ifndef _UNUM
#define _UNUM

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/uloc.h"
#include "unicode/ucurr.h"
#include "unicode/umisc.h"
#include "unicode/parseerr.h"
#include "unicode/uformattable.h"
#include "unicode/udisplaycontext.h"
#include "unicode/ufieldpositer.h"
#include "unicode/unumberoptions.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

/**
 * \file
 * \brief C API: Compatibility APIs for number formatting.
 *
 * <h2> Number Format C API </h2>
 * 
 * <p><strong>IMPORTANT:</strong> New users with are strongly encouraged to
 * see if unumberformatter.h fits their use case.  Although not deprecated,
 * this header is provided for backwards compatibility only.
 *
 * Number Format C API  Provides functions for
 * formatting and parsing a number.  Also provides methods for
 * determining which locales have number formats, and what their names
 * are.
 * <P>
 * UNumberFormat helps you to format and parse numbers for any locale.
 * Your code can be completely independent of the locale conventions
 * for decimal points, thousands-separators, or even the particular
 * decimal digits used, or whether the number format is even decimal.
 * There are different number format styles like decimal, currency,
 * percent and spellout.
 * <P>
 * To format a number for the current Locale, use one of the static
 * factory methods:
 * <pre>
 * \code
 *    UChar myString[20];
 *    double myNumber = 7.0;
 *    UErrorCode status = U_ZERO_ERROR;
 *    UNumberFormat* nf = unum_open(UNUM_DEFAULT, NULL, -1, NULL, NULL, &status);
 *    unum_formatDouble(nf, myNumber, myString, 20, NULL, &status);
 *    printf(" Example 1: %s\n", austrdup(myString) ); //austrdup( a function used to convert UChar* to char*)
 * \endcode
 * </pre>
 * If you are formatting multiple numbers, it is more efficient to get
 * the format and use it multiple times so that the system doesn't
 * have to fetch the information about the local language and country
 * conventions multiple times.
 * <pre>
 * \code
 * uint32_t i, resultlength, reslenneeded;
 * UErrorCode status = U_ZERO_ERROR;
 * UFieldPosition pos;
 * uint32_t a[] = { 123, 3333, -1234567 };
 * const uint32_t a_len = sizeof(a) / sizeof(a[0]);
 * UNumberFormat* nf;
 * UChar* result = NULL;
 *
 * nf = unum_open(UNUM_DEFAULT, NULL, -1, NULL, NULL, &status);
 * for (i = 0; i < a_len; i++) {
 *    resultlength=0;
 *    reslenneeded=unum_format(nf, a[i], NULL, resultlength, &pos, &status);
 *    result = NULL;
 *    if(status==U_BUFFER_OVERFLOW_ERROR){
 *       status=U_ZERO_ERROR;
 *       resultlength=reslenneeded+1;
 *       result=(UChar*)malloc(sizeof(UChar) * resultlength);
 *       unum_format(nf, a[i], result, resultlength, &pos, &status);
 *    }
 *    printf( " Example 2: %s\n", austrdup(result));
 *    free(result);
 * }
 * \endcode
 * </pre>
 * To format a number for a different Locale, specify it in the
 * call to unum_open().
 * <pre>
 * \code
 *     UNumberFormat* nf = unum_open(UNUM_DEFAULT, NULL, -1, "fr_FR", NULL, &success)
 * \endcode
 * </pre>
 * You can use a NumberFormat API unum_parse() to parse.
 * <pre>
 * \code
 *    UErrorCode status = U_ZERO_ERROR;
 *    int32_t pos=0;
 *    int32_t num;
 *    num = unum_parse(nf, str, u_strlen(str), &pos, &status);
 * \endcode
 * </pre>
 * Use UNUM_DECIMAL to get the normal number format for that country.
 * There are other static options available.  Use UNUM_CURRENCY
 * to get the currency number format for that country.  Use UNUM_PERCENT
 * to get a format for displaying percentages. With this format, a
 * fraction from 0.53 is displayed as 53%.
 * <P>
 * Use a pattern to create either a DecimalFormat or a RuleBasedNumberFormat
 * formatter.  The pattern must conform to the syntax defined for those
 * formatters.
 * <P>
 * You can also control the display of numbers with such function as
 * unum_getAttributes() and unum_setAttributes(), which let you set the
 * minimum fraction digits, grouping, etc.
 * @see UNumberFormatAttributes for more details
 * <P>
 * You can also use forms of the parse and format methods with
 * ParsePosition and UFieldPosition to allow you to:
 * <ul type=round>
 *   <li>(a) progressively parse through pieces of a string.
 *   <li>(b) align the decimal point and other areas.
 * </ul>
 * <p>
 * It is also possible to change or set the symbols used for a particular
 * locale like the currency symbol, the grouping separator , monetary separator
 * etc by making use of functions unum_setSymbols() and unum_getSymbols().
 */

/** A number formatter.
 *  For usage in C programs.
 *  @stable ICU 2.0
 */
typedef void* UNumberFormat;

/** The possible number format styles. 
 *  @stable ICU 2.0
 */
typedef enum UNumberFormatStyle {
    /**
     * Decimal format defined by a pattern string.
     * @stable ICU 3.0
     */
    UNUM_PATTERN_DECIMAL=0,
    /**
     * Decimal format ("normal" style).
     * @stable ICU 2.0
     */
    UNUM_DECIMAL=1,
    /**
     * Currency format (generic).
     * Defaults to UNUM_CURRENCY_STANDARD style
     * (using currency symbol, e.g., "$1.00", with non-accounting
     * style for negative values e.g. using minus sign).
     * The specific style may be specified using the -cf- locale key.
     * @stable ICU 2.0
     */
    UNUM_CURRENCY=2,
    /**
     * Percent format
     * @stable ICU 2.0
     */
    UNUM_PERCENT=3,
    /**
     * Scientific format
     * @stable ICU 2.1
     */
    UNUM_SCIENTIFIC=4,
    /**
     * Spellout rule-based format. The default ruleset can be specified/changed using
     * unum_setTextAttribute with UNUM_DEFAULT_RULESET; the available public rulesets
     * can be listed using unum_getTextAttribute with UNUM_PUBLIC_RULESETS.
     * @stable ICU 2.0
     */
    UNUM_SPELLOUT=5,
    /** 
     * Ordinal rule-based format . The default ruleset can be specified/changed using
     * unum_setTextAttribute with UNUM_DEFAULT_RULESET; the available public rulesets
     * can be listed using unum_getTextAttribute with UNUM_PUBLIC_RULESETS.
     * @stable ICU 3.0
     */
    UNUM_ORDINAL=6,
    /** 
     * Duration rule-based format 
     * @stable ICU 3.0
     */
    UNUM_DURATION=7,
    /** 
     * Numbering system rule-based format
     * @stable ICU 4.2
     */
    UNUM_NUMBERING_SYSTEM=8,
    /** 
     * Rule-based format defined by a pattern string.
     * @stable ICU 3.0
     */
    UNUM_PATTERN_RULEBASED=9,
    /**
     * Currency format with an ISO currency code, e.g., "USD1.00".
     * @stable ICU 4.8
     */
    UNUM_CURRENCY_ISO=10,
    /**
     * Currency format with a pluralized currency name,
     * e.g., "1.00 US dollar" and "3.00 US dollars".
     * @stable ICU 4.8
     */
    UNUM_CURRENCY_PLURAL=11,
    /**
     * Currency format for accounting, e.g., "($3.00)" for
     * negative currency amount instead of "-$3.00" ({@link #UNUM_CURRENCY}).
     * Overrides any style specified using -cf- key in locale.
     * @stable ICU 53
     */
    UNUM_CURRENCY_ACCOUNTING=12,
    /**
     * Currency format with a currency symbol given CASH usage, e.g., 
     * "NT$3" instead of "NT$3.23".
     * @stable ICU 54
     */
    UNUM_CASH_CURRENCY=13,
    /**
     * Decimal format expressed using compact notation
     * (short form, corresponds to UNumberCompactStyle=UNUM_SHORT)
     * e.g. "23K", "45B"
     * @stable ICU 56
     */
    UNUM_DECIMAL_COMPACT_SHORT=14,
    /**
     * Decimal format expressed using compact notation
     * (long form, corresponds to UNumberCompactStyle=UNUM_LONG)
     * e.g. "23 thousand", "45 billion"
     * @stable ICU 56
     */
    UNUM_DECIMAL_COMPACT_LONG=15,
    /**
     * Currency format with a currency symbol, e.g., "$1.00",
     * using non-accounting style for negative values (e.g. minus sign).
     * Overrides any style specified using -cf- key in locale.
     * @stable ICU 56
     */
    UNUM_CURRENCY_STANDARD=16,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UNumberFormatStyle value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UNUM_FORMAT_STYLE_COUNT=17,
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Default format
     * @stable ICU 2.0
     */
    UNUM_DEFAULT = UNUM_DECIMAL,
    /**
     * Alias for UNUM_PATTERN_DECIMAL
     * @stable ICU 3.0
     */
    UNUM_IGNORE = UNUM_PATTERN_DECIMAL
} UNumberFormatStyle;

/** The possible number format pad positions. 
 *  @stable ICU 2.0
 */
typedef enum UNumberFormatPadPosition {
    UNUM_PAD_BEFORE_PREFIX,
    UNUM_PAD_AFTER_PREFIX,
    UNUM_PAD_BEFORE_SUFFIX,
    UNUM_PAD_AFTER_SUFFIX
} UNumberFormatPadPosition;

/**
 * Constants for specifying short or long format.
 * @stable ICU 51
 */
typedef enum UNumberCompactStyle {
  /** @stable ICU 51 */
  UNUM_SHORT,
  /** @stable ICU 51 */
  UNUM_LONG
  /** @stable ICU 51 */
} UNumberCompactStyle;

/**
 * Constants for specifying currency spacing
 * @stable ICU 4.8
 */
enum UCurrencySpacing {
    /** @stable ICU 4.8 */
    UNUM_CURRENCY_MATCH,
    /** @stable ICU 4.8 */
    UNUM_CURRENCY_SURROUNDING_MATCH,
    /** @stable ICU 4.8 */
    UNUM_CURRENCY_INSERT,

    /* Do not conditionalize the following with #ifndef U_HIDE_DEPRECATED_API,
     * it is needed for layout of DecimalFormatSymbols object. */
#ifndef U_FORCE_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UCurrencySpacing value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UNUM_CURRENCY_SPACING_COUNT
#endif  // U_FORCE_HIDE_DEPRECATED_API
};
typedef enum UCurrencySpacing UCurrencySpacing; /**< @stable ICU 4.8 */


/**
 * FieldPosition and UFieldPosition selectors for format fields
 * defined by NumberFormat and UNumberFormat.
 * @stable ICU 49
 */
typedef enum UNumberFormatFields {
    /** @stable ICU 49 */
    UNUM_INTEGER_FIELD,
    /** @stable ICU 49 */
    UNUM_FRACTION_FIELD,
    /** @stable ICU 49 */
    UNUM_DECIMAL_SEPARATOR_FIELD,
    /** @stable ICU 49 */
    UNUM_EXPONENT_SYMBOL_FIELD,
    /** @stable ICU 49 */
    UNUM_EXPONENT_SIGN_FIELD,
    /** @stable ICU 49 */
    UNUM_EXPONENT_FIELD,
    /** @stable ICU 49 */
    UNUM_GROUPING_SEPARATOR_FIELD,
    /** @stable ICU 49 */
    UNUM_CURRENCY_FIELD,
    /** @stable ICU 49 */
    UNUM_PERCENT_FIELD,
    /** @stable ICU 49 */
    UNUM_PERMILL_FIELD,
    /** @stable ICU 49 */
    UNUM_SIGN_FIELD,
    /** @stable ICU 64 */
    UNUM_MEASURE_UNIT_FIELD,
    /** @stable ICU 64 */
    UNUM_COMPACT_FIELD,
    /**
     * Approximately sign. In ICU 70, this was categorized under the generic SIGN field.
     * @stable ICU 71
     */
    UNUM_APPROXIMATELY_SIGN_FIELD,

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UNumberFormatFields value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UNUM_FIELD_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
} UNumberFormatFields;


/**
 * Selectors with special numeric values to use locale default minimum grouping
 * digits for the DecimalFormat/UNumberFormat setMinimumGroupingDigits method.
 * Do not use these constants with the [U]NumberFormatter API.
 *
 * @stable ICU 68
 */
typedef enum UNumberFormatMinimumGroupingDigits {
    /**
     * Display grouping using the default strategy for all locales.
     * @stable ICU 68
     */
    UNUM_MINIMUM_GROUPING_DIGITS_AUTO = -2,
    /**
     * Display grouping using locale defaults, except do not show grouping on
     * values smaller than 10000 (such that there is a minimum of two digits
     * before the first separator).
     * @stable ICU 68
     */
    UNUM_MINIMUM_GROUPING_DIGITS_MIN2 = -3,
} UNumberFormatMinimumGroupingDigits;

/**
 * Create and return a new UNumberFormat for formatting and parsing
 * numbers.  A UNumberFormat may be used to format numbers by calling
 * {@link #unum_format }, and to parse numbers by calling {@link #unum_parse }.
 * The caller must call {@link #unum_close } when done to release resources
 * used by this object.
 * @param style The type of number format to open: one of
 * UNUM_DECIMAL, UNUM_CURRENCY, UNUM_PERCENT, UNUM_SCIENTIFIC,
 * UNUM_CURRENCY_ISO, UNUM_CURRENCY_PLURAL, UNUM_SPELLOUT,
 * UNUM_ORDINAL, UNUM_DURATION, UNUM_NUMBERING_SYSTEM,
 * UNUM_PATTERN_DECIMAL, UNUM_PATTERN_RULEBASED, or UNUM_DEFAULT.
 * If UNUM_PATTERN_DECIMAL or UNUM_PATTERN_RULEBASED is passed then the
 * number format is opened using the given pattern, which must conform
 * to the syntax described in DecimalFormat or RuleBasedNumberFormat,
 * respectively.
 *
 * <p><strong>NOTE::</strong> New users with are strongly encouraged to
 * use unumf_openForSkeletonAndLocale instead of unum_open.
 *
 * @param pattern A pattern specifying the format to use. 
 * This parameter is ignored unless the style is
 * UNUM_PATTERN_DECIMAL or UNUM_PATTERN_RULEBASED.
 * @param patternLength The number of characters in the pattern, or -1
 * if null-terminated. This parameter is ignored unless the style is
 * UNUM_PATTERN.
 * @param locale A locale identifier to use to determine formatting
 * and parsing conventions, or NULL to use the default locale.
 * @param parseErr A pointer to a UParseError struct to receive the
 * details of any parsing errors, or NULL if no parsing error details
 * are desired.
 * @param status A pointer to an input-output UErrorCode.
 * @return A pointer to a newly created UNumberFormat, or NULL if an
 * error occurred.
 * @see unum_close
 * @see DecimalFormat
 * @stable ICU 2.0
 */
U_CAPI UNumberFormat* U_EXPORT2 
unum_open(  UNumberFormatStyle    style,
            const    UChar*    pattern,
            int32_t            patternLength,
            const    char*     locale,
            UParseError*       parseErr,
            UErrorCode*        status);


/**
* Close a UNumberFormat.
* Once closed, a UNumberFormat may no longer be used.
* @param fmt The formatter to close.
* @stable ICU 2.0
*/
U_CAPI void U_EXPORT2 
unum_close(UNumberFormat* fmt);

#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUNumberFormatPointer
 * "Smart pointer" class, closes a UNumberFormat via unum_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.4
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUNumberFormatPointer, UNumberFormat, unum_close);

U_NAMESPACE_END

#endif

/**
 * Open a copy of a UNumberFormat.
 * This function performs a deep copy.
 * @param fmt The format to copy
 * @param status A pointer to an UErrorCode to receive any errors.
 * @return A pointer to a UNumberFormat identical to fmt.
 * @stable ICU 2.0
 */
U_CAPI UNumberFormat* U_EXPORT2 
unum_clone(const UNumberFormat *fmt,
       UErrorCode *status);

/**
* Format an integer using a UNumberFormat.
* The integer will be formatted according to the UNumberFormat's locale.
* @param fmt The formatter to use.
* @param number The number to format.
* @param result A pointer to a buffer to receive the NULL-terminated formatted number. If
* the formatted number fits into dest but cannot be NULL-terminated (length == resultLength)
* then the error code is set to U_STRING_NOT_TERMINATED_WARNING. If the formatted number
* doesn't fit into result then the error code is set to U_BUFFER_OVERFLOW_ERROR.
* @param resultLength The maximum size of result.
* @param pos    A pointer to a UFieldPosition.  On input, position->field
* is read.  On output, position->beginIndex and position->endIndex indicate
* the beginning and ending indices of field number position->field, if such
* a field exists.  This parameter may be NULL, in which case no field
* @param status A pointer to an UErrorCode to receive any errors
* @return The total buffer size needed; if greater than resultLength, the output was truncated.
* @see unum_formatInt64
* @see unum_formatDouble
* @see unum_parse
* @see unum_parseInt64
* @see unum_parseDouble
* @see UFieldPosition
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2 
unum_format(    const    UNumberFormat*    fmt,
        int32_t            number,
        UChar*            result,
        int32_t            resultLength,
        UFieldPosition    *pos,
        UErrorCode*        status);

/**
* Format an int64 using a UNumberFormat.
* The int64 will be formatted according to the UNumberFormat's locale.
* @param fmt The formatter to use.
* @param number The number to format.
* @param result A pointer to a buffer to receive the NULL-terminated formatted number. If
* the formatted number fits into dest but cannot be NULL-terminated (length == resultLength)
* then the error code is set to U_STRING_NOT_TERMINATED_WARNING. If the formatted number
* doesn't fit into result then the error code is set to U_BUFFER_OVERFLOW_ERROR.
* @param resultLength The maximum size of result.
* @param pos    A pointer to a UFieldPosition.  On input, position->field
* is read.  On output, position->beginIndex and position->endIndex indicate
* the beginning and ending indices of field number position->field, if such
* a field exists.  This parameter may be NULL, in which case no field
* @param status A pointer to an UErrorCode to receive any errors
* @return The total buffer size needed; if greater than resultLength, the output was truncated.
* @see unum_format
* @see unum_formatDouble
* @see unum_parse
* @see unum_parseInt64
* @see unum_parseDouble
* @see UFieldPosition
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2 
unum_formatInt64(const UNumberFormat *fmt,
        int64_t         number,
        UChar*          result,
        int32_t         resultLength,
        UFieldPosition *pos,
        UErrorCode*     status);

/**
* Format a double using a UNumberFormat.
* The double will be formatted according to the UNumberFormat's locale.
* @param fmt The formatter to use.
* @param number The number to format.
* @param result A pointer to a buffer to receive the NULL-terminated formatted number. If
* the formatted number fits into dest but cannot be NULL-terminated (length == resultLength)
* then the error code is set to U_STRING_NOT_TERMINATED_WARNING. If the formatted number
* doesn't fit into result then the error code is set to U_BUFFER_OVERFLOW_ERROR.
* @param resultLength The maximum size of result.
* @param pos    A pointer to a UFieldPosition.  On input, position->field
* is read.  On output, position->beginIndex and position->endIndex indicate
* the beginning and ending indices of field number position->field, if such
* a field exists.  This parameter may be NULL, in which case no field
* @param status A pointer to an UErrorCode to receive any errors
* @return The total buffer size needed; if greater than resultLength, the output was truncated.
* @see unum_format
* @see unum_formatInt64
* @see unum_parse
* @see unum_parseInt64
* @see unum_parseDouble
* @see UFieldPosition
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2 
unum_formatDouble(    const    UNumberFormat*  fmt,
            double          number,
            UChar*          result,
            int32_t         resultLength,
            UFieldPosition  *pos, /* 0 if ignore */
            UErrorCode*     status);

/**
* Format a double using a UNumberFormat according to the UNumberFormat's locale,
* and initialize a UFieldPositionIterator that enumerates the subcomponents of
* the resulting string.
*
* @param format
*          The formatter to use.
* @param number
*          The number to format.
* @param result
*          A pointer to a buffer to receive the NULL-terminated formatted
*          number. If the formatted number fits into dest but cannot be
*          NULL-terminated (length == resultLength) then the error code is set
*          to U_STRING_NOT_TERMINATED_WARNING. If the formatted number doesn't
*          fit into result then the error code is set to
*          U_BUFFER_OVERFLOW_ERROR.
* @param resultLength
*          The maximum size of result.
* @param fpositer
*          A pointer to a UFieldPositionIterator created by {@link #ufieldpositer_open}
*          (may be NULL if field position information is not needed, but in this
*          case it's preferable to use {@link #unum_formatDouble}). Iteration
*          information already present in the UFieldPositionIterator is deleted,
*          and the iterator is reset to apply to the fields in the formatted
*          string created by this function call. The field values and indexes
*          returned by {@link #ufieldpositer_next} represent fields denoted by
*          the UNumberFormatFields enum. Fields are not returned in a guaranteed
*          order. Fields cannot overlap, but they may nest. For example, 1234
*          could format as "1,234" which might consist of a grouping separator
*          field for ',' and an integer field encompassing the entire string.
* @param status
*          A pointer to an UErrorCode to receive any errors
* @return
*          The total buffer size needed; if greater than resultLength, the
*          output was truncated.
* @see unum_formatDouble
* @see unum_parse
* @see unum_parseDouble
* @see UFieldPositionIterator
* @see UNumberFormatFields
* @stable ICU 59
*/
U_CAPI int32_t U_EXPORT2
unum_formatDoubleForFields(const UNumberFormat* format,
                           double number,
                           UChar* result,
                           int32_t resultLength,
                           UFieldPositionIterator* fpositer,
                           UErrorCode* status);


/**
* Format a decimal number using a UNumberFormat.
* The number will be formatted according to the UNumberFormat's locale.
* The syntax of the input number is a "numeric string"
* as defined in the Decimal Arithmetic Specification, available at
* http://speleotrove.com/decimal
* @param fmt The formatter to use.
* @param number The number to format.
* @param length The length of the input number, or -1 if the input is nul-terminated.
* @param result A pointer to a buffer to receive the NULL-terminated formatted number. If
* the formatted number fits into dest but cannot be NULL-terminated (length == resultLength)
* then the error code is set to U_STRING_NOT_TERMINATED_WARNING. If the formatted number
* doesn't fit into result then the error code is set to U_BUFFER_OVERFLOW_ERROR.
* @param resultLength The maximum size of result.
* @param pos    A pointer to a UFieldPosition.  On input, position->field
*               is read.  On output, position->beginIndex and position->endIndex indicate
*               the beginning and ending indices of field number position->field, if such
*               a field exists.  This parameter may be NULL, in which case it is ignored.
* @param status A pointer to an UErrorCode to receive any errors
* @return The total buffer size needed; if greater than resultLength, the output was truncated.
* @see unum_format
* @see unum_formatInt64
* @see unum_parse
* @see unum_parseInt64
* @see unum_parseDouble
* @see UFieldPosition
* @stable ICU 4.4 
*/
U_CAPI int32_t U_EXPORT2 
unum_formatDecimal(    const    UNumberFormat*  fmt,
            const char *    number,
            int32_t         length,
            UChar*          result,
            int32_t         resultLength,
            UFieldPosition  *pos, /* 0 if ignore */
            UErrorCode*     status);

/**
 * Format a double currency amount using a UNumberFormat.
 * The double will be formatted according to the UNumberFormat's locale.
 *
 * To format an exact decimal value with a currency, use
 * `unum_setTextAttribute(UNUM_CURRENCY_CODE, ...)` followed by unum_formatDecimal.
 * Your UNumberFormat must be created with the UNUM_CURRENCY style. Alternatively,
 * consider using unumf_openForSkeletonAndLocale.
 *
 * @param fmt the formatter to use
 * @param number the number to format
 * @param currency the 3-letter null-terminated ISO 4217 currency code
 * @param result A pointer to a buffer to receive the NULL-terminated formatted number. If
 * the formatted number fits into dest but cannot be NULL-terminated (length == resultLength)
 * then the error code is set to U_STRING_NOT_TERMINATED_WARNING. If the formatted number
 * doesn't fit into result then the error code is set to U_BUFFER_OVERFLOW_ERROR.
 * @param resultLength the maximum number of UChars to write to result
 * @param pos a pointer to a UFieldPosition.  On input,
 * position->field is read.  On output, position->beginIndex and
 * position->endIndex indicate the beginning and ending indices of
 * field number position->field, if such a field exists.  This
 * parameter may be NULL, in which case it is ignored.
 * @param status a pointer to an input-output UErrorCode
 * @return the total buffer size needed; if greater than resultLength,
 * the output was truncated.
 * @see unum_formatDouble
 * @see unum_parseDoubleCurrency
 * @see UFieldPosition
 * @stable ICU 3.0
 */
U_CAPI int32_t U_EXPORT2
unum_formatDoubleCurrency(const UNumberFormat* fmt,
                          double number,
                          UChar* currency,
                          UChar* result,
                          int32_t resultLength,
                          UFieldPosition* pos,
                          UErrorCode* status);

/**
 * Format a UFormattable into a string.
 * @param fmt the formatter to use
 * @param number the number to format, as a UFormattable
 * @param result A pointer to a buffer to receive the NULL-terminated formatted number. If
 * the formatted number fits into dest but cannot be NULL-terminated (length == resultLength)
 * then the error code is set to U_STRING_NOT_TERMINATED_WARNING. If the formatted number
 * doesn't fit into result then the error code is set to U_BUFFER_OVERFLOW_ERROR.
 * @param resultLength the maximum number of UChars to write to result
 * @param pos a pointer to a UFieldPosition.  On input,
 * position->field is read.  On output, position->beginIndex and
 * position->endIndex indicate the beginning and ending indices of
 * field number position->field, if such a field exists.  This
 * parameter may be NULL, in which case it is ignored.
 * @param status a pointer to an input-output UErrorCode
 * @return the total buffer size needed; if greater than resultLength,
 * the output was truncated. Will return 0 on error.
 * @see unum_parseToUFormattable
 * @stable ICU 52
 */
U_CAPI int32_t U_EXPORT2
unum_formatUFormattable(const UNumberFormat* fmt,
                        const UFormattable *number,
                        UChar *result,
                        int32_t resultLength,
                        UFieldPosition *pos,
                        UErrorCode *status);

/**
* Parse a string into an integer using a UNumberFormat.
* The string will be parsed according to the UNumberFormat's locale.
* Note: parsing is not supported for styles UNUM_DECIMAL_COMPACT_SHORT
* and UNUM_DECIMAL_COMPACT_LONG.
* @param fmt The formatter to use.
* @param text The text to parse.
* @param textLength The length of text, or -1 if null-terminated.
* @param parsePos If not NULL, on input a pointer to an integer specifying the offset at which
* to begin parsing.  If not NULL, on output the offset at which parsing ended.
* @param status A pointer to an UErrorCode to receive any errors
* @return The value of the parsed integer
* @see unum_parseInt64
* @see unum_parseDouble
* @see unum_format
* @see unum_formatInt64
* @see unum_formatDouble
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2 
unum_parse(    const   UNumberFormat*  fmt,
        const   UChar*          text,
        int32_t         textLength,
        int32_t         *parsePos /* 0 = start */,
        UErrorCode      *status);

/**
* Parse a string into an int64 using a UNumberFormat.
* The string will be parsed according to the UNumberFormat's locale.
* Note: parsing is not supported for styles UNUM_DECIMAL_COMPACT_SHORT
* and UNUM_DECIMAL_COMPACT_LONG.
* @param fmt The formatter to use.
* @param text The text to parse.
* @param textLength The length of text, or -1 if null-terminated.
* @param parsePos If not NULL, on input a pointer to an integer specifying the offset at which
* to begin parsing.  If not NULL, on output the offset at which parsing ended.
* @param status A pointer to an UErrorCode to receive any errors
* @return The value of the parsed integer
* @see unum_parse
* @see unum_parseDouble
* @see unum_format
* @see unum_formatInt64
* @see unum_formatDouble
* @stable ICU 2.8
*/
U_CAPI int64_t U_EXPORT2 
unum_parseInt64(const UNumberFormat*  fmt,
        const UChar*  text,
        int32_t       textLength,
        int32_t       *parsePos /* 0 = start */,
        UErrorCode    *status);

/**
* Parse a string into a double using a UNumberFormat.
* The string will be parsed according to the UNumberFormat's locale.
* Note: parsing is not supported for styles UNUM_DECIMAL_COMPACT_SHORT
* and UNUM_DECIMAL_COMPACT_LONG.
* @param fmt The formatter to use.
* @param text The text to parse.
* @param textLength The length of text, or -1 if null-terminated.
* @param parsePos If not NULL, on input a pointer to an integer specifying the offset at which
* to begin parsing.  If not NULL, on output the offset at which parsing ended.
* @param status A pointer to an UErrorCode to receive any errors
* @return The value of the parsed double
* @see unum_parse
* @see unum_parseInt64
* @see unum_format
* @see unum_formatInt64
* @see unum_formatDouble
* @stable ICU 2.0
*/
U_CAPI double U_EXPORT2 
unum_parseDouble(    const   UNumberFormat*  fmt,
            const   UChar*          text,
            int32_t         textLength,
            int32_t         *parsePos /* 0 = start */,
            UErrorCode      *status);


/**
* Parse a number from a string into an unformatted numeric string using a UNumberFormat.
* The input string will be parsed according to the UNumberFormat's locale.
* The syntax of the output is a "numeric string"
* as defined in the Decimal Arithmetic Specification, available at
* http://speleotrove.com/decimal
* Note: parsing is not supported for styles UNUM_DECIMAL_COMPACT_SHORT
* and UNUM_DECIMAL_COMPACT_LONG.
* @param fmt The formatter to use.
* @param text The text to parse.
* @param textLength The length of text, or -1 if null-terminated.
* @param parsePos If not NULL, on input a pointer to an integer specifying the offset at which
*                 to begin parsing.  If not NULL, on output the offset at which parsing ended.
* @param outBuf A (char *) buffer to receive the parsed number as a string.  The output string
*               will be nul-terminated if there is sufficient space.
* @param outBufLength The size of the output buffer.  May be zero, in which case
*               the outBuf pointer may be NULL, and the function will return the
*               size of the output string.
* @param status A pointer to an UErrorCode to receive any errors
* @return the length of the output string, not including any terminating nul.
* @see unum_parse
* @see unum_parseInt64
* @see unum_format
* @see unum_formatInt64
* @see unum_formatDouble
* @stable ICU 4.4
*/
U_CAPI int32_t U_EXPORT2 
unum_parseDecimal(const   UNumberFormat*  fmt,
                 const   UChar*          text,
                         int32_t         textLength,
                         int32_t         *parsePos /* 0 = start */,
                         char            *outBuf,
                         int32_t         outBufLength,
                         UErrorCode      *status);

/**
 * Parse a string into a double and a currency using a UNumberFormat.
 * The string will be parsed according to the UNumberFormat's locale.
 * @param fmt the formatter to use
 * @param text the text to parse
 * @param textLength the length of text, or -1 if null-terminated
 * @param parsePos a pointer to an offset index into text at which to
 * begin parsing. On output, *parsePos will point after the last
 * parsed character.  This parameter may be NULL, in which case parsing
 * begins at offset 0.
 * @param currency a pointer to the buffer to receive the parsed null-
 * terminated currency.  This buffer must have a capacity of at least
 * 4 UChars.
 * @param status a pointer to an input-output UErrorCode
 * @return the parsed double
 * @see unum_parseDouble
 * @see unum_formatDoubleCurrency
 * @stable ICU 3.0
 */
U_CAPI double U_EXPORT2
unum_parseDoubleCurrency(const UNumberFormat* fmt,
                         const UChar* text,
                         int32_t textLength,
                         int32_t* parsePos, /* 0 = start */
                         UChar* currency,
                         UErrorCode* status);

/**
 * Parse a UChar string into a UFormattable.
 * Example code:
 * \snippet test/cintltst/cnumtst.c unum_parseToUFormattable
 * Note: parsing is not supported for styles UNUM_DECIMAL_COMPACT_SHORT
 * and UNUM_DECIMAL_COMPACT_LONG.
 * @param fmt the formatter to use
 * @param result the UFormattable to hold the result. If NULL, a new UFormattable will be allocated (which the caller must close with ufmt_close).
 * @param text the text to parse
 * @param textLength the length of text, or -1 if null-terminated
 * @param parsePos a pointer to an offset index into text at which to
 * begin parsing. On output, *parsePos will point after the last
 * parsed character.  This parameter may be NULL in which case parsing
 * begins at offset 0.
 * @param status a pointer to an input-output UErrorCode
 * @return the UFormattable.  Will be ==result unless NULL was passed in for result, in which case it will be the newly opened UFormattable.
 * @see ufmt_getType
 * @see ufmt_close
 * @stable ICU 52
 */
U_CAPI UFormattable* U_EXPORT2
unum_parseToUFormattable(const UNumberFormat* fmt,
                         UFormattable *result,
                         const UChar* text,
                         int32_t textLength,
                         int32_t* parsePos, /* 0 = start */
                         UErrorCode* status);

/**
 * Set the pattern used by a UNumberFormat.  This can only be used
 * on a DecimalFormat, other formats return U_UNSUPPORTED_ERROR
 * in the status.
 * @param format The formatter to set.
 * @param localized true if the pattern is localized, false otherwise.
 * @param pattern The new pattern
 * @param patternLength The length of pattern, or -1 if null-terminated.
 * @param parseError A pointer to UParseError to receive information
 * about errors occurred during parsing, or NULL if no parse error
 * information is desired.
 * @param status A pointer to an input-output UErrorCode.
 * @see unum_toPattern
 * @see DecimalFormat
 * @stable ICU 2.0
 */
U_CAPI void U_EXPORT2 
unum_applyPattern(          UNumberFormat  *format,
                            UBool          localized,
                    const   UChar          *pattern,
                            int32_t         patternLength,
                            UParseError    *parseError,
                            UErrorCode     *status
                                    );

/**
* Get a locale for which decimal formatting patterns are available.
* A UNumberFormat in a locale returned by this function will perform the correct
* formatting and parsing for the locale.  The results of this call are not
* valid for rule-based number formats.
* @param localeIndex The index of the desired locale.
* @return A locale for which number formatting patterns are available, or 0 if none.
* @see unum_countAvailable
* @stable ICU 2.0
*/
U_CAPI const char* U_EXPORT2 
unum_getAvailable(int32_t localeIndex);

/**
* Determine how many locales have decimal formatting patterns available.  The
* results of this call are not valid for rule-based number formats.
* This function is useful for determining the loop ending condition for
* calls to {@link #unum_getAvailable }.
* @return The number of locales for which decimal formatting patterns are available.
* @see unum_getAvailable
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2 
unum_countAvailable(void);

#if UCONFIG_HAVE_PARSEALLINPUT
/* The UNumberFormatAttributeValue type cannot be #ifndef U_HIDE_INTERNAL_API, needed for .h variable declaration */
/**
 * @internal
 */
typedef enum UNumberFormatAttributeValue {
#ifndef U_HIDE_INTERNAL_API
  /** @internal */
  UNUM_NO = 0,
  /** @internal */
  UNUM_YES = 1,
  /** @internal */
  UNUM_MAYBE = 2
#else
  /** @internal */
  UNUM_FORMAT_ATTRIBUTE_VALUE_HIDDEN
#endif /* U_HIDE_INTERNAL_API */
} UNumberFormatAttributeValue;
#endif

/** The possible UNumberFormat numeric attributes @stable ICU 2.0 */
typedef enum UNumberFormatAttribute {
  /** Parse integers only */
  UNUM_PARSE_INT_ONLY,
  /** Use grouping separator */
  UNUM_GROUPING_USED,
  /** Always show decimal point */
  UNUM_DECIMAL_ALWAYS_SHOWN,
  /** Maximum integer digits */
  UNUM_MAX_INTEGER_DIGITS,
  /** Minimum integer digits */
  UNUM_MIN_INTEGER_DIGITS,
  /** Integer digits */
  UNUM_INTEGER_DIGITS,
  /** Maximum fraction digits */
  UNUM_MAX_FRACTION_DIGITS,
  /** Minimum fraction digits */
  UNUM_MIN_FRACTION_DIGITS,
  /** Fraction digits */
  UNUM_FRACTION_DIGITS,
  /** Multiplier */
  UNUM_MULTIPLIER,
  /** Grouping size */
  UNUM_GROUPING_SIZE,
  /** Rounding Mode */
  UNUM_ROUNDING_MODE,
  /** Rounding increment */
  UNUM_ROUNDING_INCREMENT,
  /** The width to which the output of <code>format()</code> is padded. */
  UNUM_FORMAT_WIDTH,
  /** The position at which padding will take place. */
  UNUM_PADDING_POSITION,
  /** Secondary grouping size */
  UNUM_SECONDARY_GROUPING_SIZE,
  /** Use significant digits
   * @stable ICU 3.0 */
  UNUM_SIGNIFICANT_DIGITS_USED,
  /** Minimum significant digits
   * @stable ICU 3.0 */
  UNUM_MIN_SIGNIFICANT_DIGITS,
  /** Maximum significant digits
   * @stable ICU 3.0 */
  UNUM_MAX_SIGNIFICANT_DIGITS,
  /** Lenient parse mode used by rule-based formats.
   * @stable ICU 3.0
   */
  UNUM_LENIENT_PARSE,
#if UCONFIG_HAVE_PARSEALLINPUT
  /** Consume all input. (may use fastpath). Set to UNUM_YES (require fastpath), UNUM_NO (skip fastpath), or UNUM_MAYBE (heuristic).
   * This is an internal ICU API. Do not use.
   * @internal
   */
  UNUM_PARSE_ALL_INPUT = 20,
#endif
  /** 
    * Scale, which adjusts the position of the
    * decimal point when formatting.  Amounts will be multiplied by 10 ^ (scale)
    * before they are formatted.  The default value for the scale is 0 ( no adjustment ).
    *
    * <p>Example: setting the scale to 3, 123 formats as "123,000"
    * <p>Example: setting the scale to -4, 123 formats as "0.0123"
    *
    * This setting is analogous to getMultiplierScale() and setMultiplierScale() in decimfmt.h.
    *
   * @stable ICU 51 */
  UNUM_SCALE = 21,

  /**
   * Minimum grouping digits; most commonly set to 2 to print "1000" instead of "1,000".
   * See DecimalFormat::getMinimumGroupingDigits().
   *
   * For better control over grouping strategies, use UNumberFormatter.
   *
   * @stable ICU 64
   */
  UNUM_MINIMUM_GROUPING_DIGITS = 22,

  /** 
   * if this attribute is set to 0, it is set to UNUM_CURRENCY_STANDARD purpose,
   * otherwise it is UNUM_CASH_CURRENCY purpose
   * Default: 0 (UNUM_CURRENCY_STANDARD purpose)
   * @stable ICU 54
   */
  UNUM_CURRENCY_USAGE = 23,

#ifndef U_HIDE_INTERNAL_API
  /** One below the first bitfield-boolean item.
   * All items after this one are stored in boolean form.
   * @internal */
  UNUM_MAX_NONBOOLEAN_ATTRIBUTE = 0x0FFF,
#endif /* U_HIDE_INTERNAL_API */

  /** If 1, specifies that if setting the "max integer digits" attribute would truncate a value, set an error status rather than silently truncating.
   * For example,  formatting the value 1234 with 4 max int digits would succeed, but formatting 12345 would fail. There is no effect on parsing.
   * Default: 0 (not set)
   * @stable ICU 50
   */
  UNUM_FORMAT_FAIL_IF_MORE_THAN_MAX_DIGITS = 0x1000,
  /** 
   * if this attribute is set to 1, specifies that, if the pattern doesn't contain an exponent, the exponent will not be parsed. If the pattern does contain an exponent, this attribute has no effect.
   * Has no effect on formatting.
   * Default: 0 (unset)
   * @stable ICU 50
   */
  UNUM_PARSE_NO_EXPONENT = 0x1001,

  /** 
   * if this attribute is set to 1, specifies that, if the pattern contains a 
   * decimal mark the input is required to have one. If this attribute is set to 0,
   * specifies that input does not have to contain a decimal mark.
   * Has no effect on formatting.
   * Default: 0 (unset)
   * @stable ICU 54
   */
  UNUM_PARSE_DECIMAL_MARK_REQUIRED = 0x1002,

  /**
   * Parsing: if set to 1, parsing is sensitive to case (lowercase/uppercase).
   *
   * @stable ICU 64
   */
  UNUM_PARSE_CASE_SENSITIVE = 0x1003,

  /**
   * Formatting: if set to 1, whether to show the plus sign on non-negative numbers.
   *
   * For better control over sign display, use UNumberFormatter.
   *
   * @stable ICU 64
   */
  UNUM_SIGN_ALWAYS_SHOWN = 0x1004,

#ifndef U_HIDE_INTERNAL_API
  /** Limit of boolean attributes. (value should
   * not depend on U_HIDE conditionals)
   * @internal */
  UNUM_LIMIT_BOOLEAN_ATTRIBUTE = 0x1005,
#endif /* U_HIDE_INTERNAL_API */

} UNumberFormatAttribute;

/**
* Returns true if the formatter supports the specified attribute and false if not.
* @param fmt The formatter to query.
* @param attr The attribute to query.  This can be any value of UNumberFormatterAttribute,
* regardless of type.
* @return True if the requested attribute is supported by the formatter; false if not.
* @see unum_getAttribute
* @see unum_setAttribute
* @see unum_getDoubleAttribute
* @see unum_setDoubleAttribute
* @see unum_getTextAttribute
* @see unum_setTextAttribute
* @stable ICU 72
*/
U_CAPI bool U_EXPORT2
unum_hasAttribute(const UNumberFormat*          fmt,
          UNumberFormatAttribute  attr);

/**
* Get a numeric attribute associated with a UNumberFormat.
* An example of a numeric attribute is the number of integer digits a formatter will produce.
* @param fmt The formatter to query.
* @param attr The attribute to query; one of UNUM_PARSE_INT_ONLY, UNUM_GROUPING_USED,
* UNUM_DECIMAL_ALWAYS_SHOWN, UNUM_MAX_INTEGER_DIGITS, UNUM_MIN_INTEGER_DIGITS, UNUM_INTEGER_DIGITS,
* UNUM_MAX_FRACTION_DIGITS, UNUM_MIN_FRACTION_DIGITS, UNUM_FRACTION_DIGITS, UNUM_MULTIPLIER,
* UNUM_GROUPING_SIZE, UNUM_ROUNDING_MODE, UNUM_FORMAT_WIDTH, UNUM_PADDING_POSITION, UNUM_SECONDARY_GROUPING_SIZE,
* UNUM_SCALE, UNUM_MINIMUM_GROUPING_DIGITS.
* @return The value of attr, or -1 if the formatter doesn't have the requested attribute.  The caller should use unum_hasAttribute() to tell if the attribute
* is available, rather than relaying on this function returning -1.
* @see unum_hasAttribute
* @see unum_setAttribute
* @see unum_getDoubleAttribute
* @see unum_setDoubleAttribute
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2 
unum_getAttribute(const UNumberFormat*          fmt,
          UNumberFormatAttribute  attr);

/**
* Set a numeric attribute associated with a UNumberFormat.
* An example of a numeric attribute is the number of integer digits a formatter will produce.  If the
* formatter does not understand the attribute, the call is ignored.  Rule-based formatters only understand
* the lenient-parse attribute.  The caller can use unum_hasAttribute() to find out if the formatter supports the attribute.
* @param fmt The formatter to set.
* @param attr The attribute to set; one of UNUM_PARSE_INT_ONLY, UNUM_GROUPING_USED,
* UNUM_DECIMAL_ALWAYS_SHOWN, UNUM_MAX_INTEGER_DIGITS, UNUM_MIN_INTEGER_DIGITS, UNUM_INTEGER_DIGITS,
* UNUM_MAX_FRACTION_DIGITS, UNUM_MIN_FRACTION_DIGITS, UNUM_FRACTION_DIGITS, UNUM_MULTIPLIER,
* UNUM_GROUPING_SIZE, UNUM_ROUNDING_MODE, UNUM_FORMAT_WIDTH, UNUM_PADDING_POSITION, UNUM_SECONDARY_GROUPING_SIZE,
* UNUM_LENIENT_PARSE, UNUM_SCALE, UNUM_MINIMUM_GROUPING_DIGITS.
* @param newValue The new value of attr.
* @see unum_hasAttribute
* @see unum_getAttribute
* @see unum_getDoubleAttribute
* @see unum_setDoubleAttribute
* @see unum_getTextAttribute
* @see unum_setTextAttribute
* @stable ICU 2.0
*/
U_CAPI void U_EXPORT2 
unum_setAttribute(    UNumberFormat*          fmt,
            UNumberFormatAttribute  attr,
            int32_t                 newValue);


/**
* Get a numeric attribute associated with a UNumberFormat.
* An example of a numeric attribute is the number of integer digits a formatter will produce.
* If the formatter does not understand the attribute, -1 is returned.  The caller should use unum_hasAttribute()
* to determine if the attribute is supported, rather than relying on this function returning -1.
* @param fmt The formatter to query.
* @param attr The attribute to query; e.g. UNUM_ROUNDING_INCREMENT.
* @return The value of attr, or -1 if the formatter doesn't understand the attribute.
* @see unum_hasAttribute
* @see unum_getAttribute
* @see unum_setAttribute
* @see unum_setDoubleAttribute
* @see unum_getTextAttribute
* @see unum_setTextAttribute
* @stable ICU 2.0
*/
U_CAPI double U_EXPORT2 
unum_getDoubleAttribute(const UNumberFormat*          fmt,
          UNumberFormatAttribute  attr);

/**
* Set a numeric attribute associated with a UNumberFormat.
* An example of a numeric attribute is the number of integer digits a formatter will produce.
* If the formatter does not understand the attribute, this call is ignored.  The caller can use
* unum_hasAttribute() to tell in advance whether the formatter understands the attribute.
* @param fmt The formatter to set.
* @param attr The attribute to set; e.g. UNUM_ROUNDING_INCREMENT.
* @param newValue The new value of attr.
* @see unum_hasAttribute
* @see unum_getAttribute
* @see unum_setAttribute
* @see unum_getDoubleAttribute
* @see unum_getTextAttribute
* @see unum_setTextAttribute
* @stable ICU 2.0
*/
U_CAPI void U_EXPORT2 
unum_setDoubleAttribute(    UNumberFormat*          fmt,
            UNumberFormatAttribute  attr,
            double                 newValue);

/** The possible UNumberFormat text attributes @stable ICU 2.0*/
typedef enum UNumberFormatTextAttribute {
  /** Positive prefix */
  UNUM_POSITIVE_PREFIX,
  /** Positive suffix */
  UNUM_POSITIVE_SUFFIX,
  /** Negative prefix */
  UNUM_NEGATIVE_PREFIX,
  /** Negative suffix */
  UNUM_NEGATIVE_SUFFIX,
  /** The character used to pad to the format width. */
  UNUM_PADDING_CHARACTER,
  /** The ISO currency code */
  UNUM_CURRENCY_CODE,
  /**
   * The default rule set, such as "%spellout-numbering-year:", "%spellout-cardinal:",
   * "%spellout-ordinal-masculine-plural:", "%spellout-ordinal-feminine:", or
   * "%spellout-ordinal-neuter:". The available public rulesets can be listed using
   * unum_getTextAttribute with UNUM_PUBLIC_RULESETS. This is only available with
   * rule-based formatters.
   * @stable ICU 3.0
   */
  UNUM_DEFAULT_RULESET,
  /**
   * The public rule sets.  This is only available with rule-based formatters.
   * This is a read-only attribute.  The public rulesets are returned as a
   * single string, with each ruleset name delimited by ';' (semicolon). See the
   * CLDR LDML spec for more information about RBNF rulesets:
   * http://www.unicode.org/reports/tr35/tr35-numbers.html#Rule-Based_Number_Formatting
   * @stable ICU 3.0
   */
  UNUM_PUBLIC_RULESETS
} UNumberFormatTextAttribute;

/**
* Get a text attribute associated with a UNumberFormat.
* An example of a text attribute is the suffix for positive numbers.  If the formatter
* does not understand the attribute, U_UNSUPPORTED_ERROR is returned as the status.
* Rule-based formatters only understand UNUM_DEFAULT_RULESET and UNUM_PUBLIC_RULESETS.
* @param fmt The formatter to query.
* @param tag The attribute to query; one of UNUM_POSITIVE_PREFIX, UNUM_POSITIVE_SUFFIX,
* UNUM_NEGATIVE_PREFIX, UNUM_NEGATIVE_SUFFIX, UNUM_PADDING_CHARACTER, UNUM_CURRENCY_CODE,
* UNUM_DEFAULT_RULESET, or UNUM_PUBLIC_RULESETS.
* @param result A pointer to a buffer to receive the attribute.
* @param resultLength The maximum size of result.
* @param status A pointer to an UErrorCode to receive any errors
* @return The total buffer size needed; if greater than resultLength, the output was truncated.
* @see unum_setTextAttribute
* @see unum_getAttribute
* @see unum_setAttribute
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2 
unum_getTextAttribute(    const    UNumberFormat*                    fmt,
            UNumberFormatTextAttribute      tag,
            UChar*                            result,
            int32_t                            resultLength,
            UErrorCode*                        status);

/**
* Set a text attribute associated with a UNumberFormat.
* An example of a text attribute is the suffix for positive numbers.  Rule-based formatters
* only understand UNUM_DEFAULT_RULESET.
* @param fmt The formatter to set.
* @param tag The attribute to set; one of UNUM_POSITIVE_PREFIX, UNUM_POSITIVE_SUFFIX,
* UNUM_NEGATIVE_PREFIX, UNUM_NEGATIVE_SUFFIX, UNUM_PADDING_CHARACTER, UNUM_CURRENCY_CODE,
* or UNUM_DEFAULT_RULESET.
* @param newValue The new value of attr.
* @param newValueLength The length of newValue, or -1 if null-terminated.
* @param status A pointer to an UErrorCode to receive any errors
* @see unum_getTextAttribute
* @see unum_getAttribute
* @see unum_setAttribute
* @stable ICU 2.0
*/
U_CAPI void U_EXPORT2 
unum_setTextAttribute(    UNumberFormat*                    fmt,
            UNumberFormatTextAttribute      tag,
            const    UChar*                            newValue,
            int32_t                            newValueLength,
            UErrorCode                        *status);

/**
 * Extract the pattern from a UNumberFormat.  The pattern will follow
 * the DecimalFormat pattern syntax.
 * @param fmt The formatter to query.
 * @param isPatternLocalized true if the pattern should be localized,
 * false otherwise.  This is ignored if the formatter is a rule-based
 * formatter.
 * @param result A pointer to a buffer to receive the pattern.
 * @param resultLength The maximum size of result.
 * @param status A pointer to an input-output UErrorCode.
 * @return The total buffer size needed; if greater than resultLength,
 * the output was truncated.
 * @see unum_applyPattern
 * @see DecimalFormat
 * @stable ICU 2.0
 */
U_CAPI int32_t U_EXPORT2 
unum_toPattern(    const    UNumberFormat*          fmt,
        UBool                  isPatternLocalized,
        UChar*                  result,
        int32_t                 resultLength,
        UErrorCode*             status);


/**
 * Constants for specifying a number format symbol.
 * @stable ICU 2.0
 */
typedef enum UNumberFormatSymbol {
  /** The decimal separator */
  UNUM_DECIMAL_SEPARATOR_SYMBOL = 0,
  /** The grouping separator */
  UNUM_GROUPING_SEPARATOR_SYMBOL = 1,
  /** The pattern separator */
  UNUM_PATTERN_SEPARATOR_SYMBOL = 2,
  /** The percent sign */
  UNUM_PERCENT_SYMBOL = 3,
  /** Zero*/
  UNUM_ZERO_DIGIT_SYMBOL = 4,
  /** Character representing a digit in the pattern */
  UNUM_DIGIT_SYMBOL = 5,
  /** The minus sign */
  UNUM_MINUS_SIGN_SYMBOL = 6,
  /** The plus sign */
  UNUM_PLUS_SIGN_SYMBOL = 7,
  /** The currency symbol */
  UNUM_CURRENCY_SYMBOL = 8,
  /** The international currency symbol */
  UNUM_INTL_CURRENCY_SYMBOL = 9,
  /** The monetary separator */
  UNUM_MONETARY_SEPARATOR_SYMBOL = 10,
  /** The exponential symbol */
  UNUM_EXPONENTIAL_SYMBOL = 11,
  /** Per mill symbol */
  UNUM_PERMILL_SYMBOL = 12,
  /** Escape padding character */
  UNUM_PAD_ESCAPE_SYMBOL = 13,
  /** Infinity symbol */
  UNUM_INFINITY_SYMBOL = 14,
  /** Nan symbol */
  UNUM_NAN_SYMBOL = 15,
  /** Significant digit symbol
   * @stable ICU 3.0 */
  UNUM_SIGNIFICANT_DIGIT_SYMBOL = 16,
  /** The monetary grouping separator 
   * @stable ICU 3.6
   */
  UNUM_MONETARY_GROUPING_SEPARATOR_SYMBOL = 17,
  /** One
   * @stable ICU 4.6
   */
  UNUM_ONE_DIGIT_SYMBOL = 18,
  /** Two
   * @stable ICU 4.6
   */
  UNUM_TWO_DIGIT_SYMBOL = 19,
  /** Three
   * @stable ICU 4.6
   */
  UNUM_THREE_DIGIT_SYMBOL = 20,
  /** Four
   * @stable ICU 4.6
   */
  UNUM_FOUR_DIGIT_SYMBOL = 21,
  /** Five
   * @stable ICU 4.6
   */
  UNUM_FIVE_DIGIT_SYMBOL = 22,
  /** Six
   * @stable ICU 4.6
   */
  UNUM_SIX_DIGIT_SYMBOL = 23,
  /** Seven
    * @stable ICU 4.6
   */
  UNUM_SEVEN_DIGIT_SYMBOL = 24,
  /** Eight
   * @stable ICU 4.6
   */
  UNUM_EIGHT_DIGIT_SYMBOL = 25,
  /** Nine
   * @stable ICU 4.6
   */
  UNUM_NINE_DIGIT_SYMBOL = 26,

  /** Multiplication sign
   * @stable ICU 54
   */
  UNUM_EXPONENT_MULTIPLICATION_SYMBOL = 27,

#ifndef U_HIDE_INTERNAL_API
  /** Approximately sign.
   * @internal
   */
  UNUM_APPROXIMATELY_SIGN_SYMBOL = 28,
#endif

#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UNumberFormatSymbol value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
  UNUM_FORMAT_SYMBOL_COUNT = 29
#endif  /* U_HIDE_DEPRECATED_API */
} UNumberFormatSymbol;

/**
* Get a symbol associated with a UNumberFormat.
* A UNumberFormat uses symbols to represent the special locale-dependent
* characters in a number, for example the percent sign. This API is not
* supported for rule-based formatters.
* @param fmt The formatter to query.
* @param symbol The UNumberFormatSymbol constant for the symbol to get
* @param buffer The string buffer that will receive the symbol string;
*               if it is NULL, then only the length of the symbol is returned
* @param size The size of the string buffer
* @param status A pointer to an UErrorCode to receive any errors
* @return The length of the symbol; the buffer is not modified if
*         <code>length&gt;=size</code>
* @see unum_setSymbol
* @stable ICU 2.0
*/
U_CAPI int32_t U_EXPORT2
unum_getSymbol(const UNumberFormat *fmt,
               UNumberFormatSymbol symbol,
               UChar *buffer,
               int32_t size,
               UErrorCode *status);

/**
* Set a symbol associated with a UNumberFormat.
* A UNumberFormat uses symbols to represent the special locale-dependent
* characters in a number, for example the percent sign.  This API is not
* supported for rule-based formatters.
* @param fmt The formatter to set.
* @param symbol The UNumberFormatSymbol constant for the symbol to set
* @param value The string to set the symbol to
* @param length The length of the string, or -1 for a zero-terminated string
* @param status A pointer to an UErrorCode to receive any errors.
* @see unum_getSymbol
* @stable ICU 2.0
*/
U_CAPI void U_EXPORT2
unum_setSymbol(UNumberFormat *fmt,
               UNumberFormatSymbol symbol,
               const UChar *value,
               int32_t length,
               UErrorCode *status);


/**
 * Get the locale for this number format object.
 * You can choose between valid and actual locale.
 * @param fmt The formatter to get the locale from
 * @param type type of the locale we're looking for (valid or actual) 
 * @param status error code for the operation
 * @return the locale name
 * @stable ICU 2.8
 */
U_CAPI const char* U_EXPORT2
unum_getLocaleByType(const UNumberFormat *fmt,
                     ULocDataLocaleType type,
                     UErrorCode* status); 

/**
 * Set a particular UDisplayContext value in the formatter, such as
 * UDISPCTX_CAPITALIZATION_FOR_STANDALONE.
 * @param fmt The formatter for which to set a UDisplayContext value.
 * @param value The UDisplayContext value to set.
 * @param status A pointer to an UErrorCode to receive any errors
 * @stable ICU 53
 */
U_CAPI void U_EXPORT2
unum_setContext(UNumberFormat* fmt, UDisplayContext value, UErrorCode* status);

/**
 * Get the formatter's UDisplayContext value for the specified UDisplayContextType,
 * such as UDISPCTX_TYPE_CAPITALIZATION.
 * @param fmt The formatter to query.
 * @param type The UDisplayContextType whose value to return
 * @param status A pointer to an UErrorCode to receive any errors
 * @return The UDisplayContextValue for the specified type.
 * @stable ICU 53
 */
U_CAPI UDisplayContext U_EXPORT2
unum_getContext(const UNumberFormat *fmt, UDisplayContextType type, UErrorCode* status);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
