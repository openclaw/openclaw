// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*****************************************************************************************
* Copyright (C) 2010-2013, International Business Machines
* Corporation and others. All Rights Reserved.
*****************************************************************************************
*/

#ifndef UPLURALRULES_H
#define UPLURALRULES_H

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/uenum.h"

#if U_SHOW_CPLUSPLUS_API
#include "unicode/localpointer.h"
#endif   // U_SHOW_CPLUSPLUS_API

#ifndef U_HIDE_INTERNAL_API
#include "unicode/unum.h"
#endif  /* U_HIDE_INTERNAL_API */

// Forward-declaration
struct UFormattedNumber;
struct UFormattedNumberRange;

/**
 * \file
 * \brief C API: Plural rules, select plural keywords for numeric values.
 *
 * A UPluralRules object defines rules for mapping non-negative numeric
 * values onto a small set of keywords. Rules are constructed from a text
 * description, consisting of a series of keywords and conditions.
 * The uplrules_select function examines each condition in order and
 * returns the keyword for the first condition that matches the number.
 * If none match, the default rule(other) is returned.
 *
 * For more information, see the
 * LDML spec, Part 3.5 Language Plural Rules:
 * https://www.unicode.org/reports/tr35/tr35-numbers.html#Language_Plural_Rules
 *
 * Keywords: ICU locale data has 6 predefined values -
 * 'zero', 'one', 'two', 'few', 'many' and 'other'. Callers need to check
 * the value of keyword returned by the uplrules_select function.
 *
 * These are based on CLDR <i>Language Plural Rules</i>. For these
 * predefined rules, see the CLDR page at
 * https://unicode-org.github.io/cldr-staging/charts/latest/supplemental/language_plural_rules.html
 */

/**
 * Type of plurals and PluralRules.
 * @stable ICU 50
 */
enum UPluralType {
    /**
     * Plural rules for cardinal numbers: 1 file vs. 2 files.
     * @stable ICU 50
     */
    UPLURAL_TYPE_CARDINAL,
    /**
     * Plural rules for ordinal numbers: 1st file, 2nd file, 3rd file, 4th file, etc.
     * @stable ICU 50
     */
    UPLURAL_TYPE_ORDINAL,
#ifndef U_HIDE_DEPRECATED_API
    /**
     * One more than the highest normal UPluralType value.
     * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
     */
    UPLURAL_TYPE_COUNT
#endif  /* U_HIDE_DEPRECATED_API */
};
/**
 * @stable ICU 50
 */
typedef enum UPluralType UPluralType;

/**
 * Opaque UPluralRules object for use in C programs.
 * @stable ICU 4.8
 */
struct UPluralRules;
typedef struct UPluralRules UPluralRules;  /**< C typedef for struct UPluralRules. @stable ICU 4.8 */

/**
 * Opens a new UPluralRules object using the predefined cardinal-number plural rules for a
 * given locale.
 * Same as uplrules_openForType(locale, UPLURAL_TYPE_CARDINAL, status).
 * @param locale The locale for which the rules are desired.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return A UPluralRules for the specified locale, or NULL if an error occurred.
 * @stable ICU 4.8
 */
U_CAPI UPluralRules* U_EXPORT2
uplrules_open(const char *locale, UErrorCode *status);

/**
 * Opens a new UPluralRules object using the predefined plural rules for a
 * given locale and the plural type.
 * @param locale The locale for which the rules are desired.
 * @param type The plural type (e.g., cardinal or ordinal).
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return A UPluralRules for the specified locale, or NULL if an error occurred.
 * @stable ICU 50
 */
U_CAPI UPluralRules* U_EXPORT2
uplrules_openForType(const char *locale, UPluralType type, UErrorCode *status);

/**
 * Closes a UPluralRules object. Once closed it may no longer be used.
 * @param uplrules The UPluralRules object to close.
 * @stable ICU 4.8
 */
U_CAPI void U_EXPORT2
uplrules_close(UPluralRules *uplrules);


#if U_SHOW_CPLUSPLUS_API

U_NAMESPACE_BEGIN

/**
 * \class LocalUPluralRulesPointer
 * "Smart pointer" class, closes a UPluralRules via uplrules_close().
 * For most methods see the LocalPointerBase base class.
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 4.8
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUPluralRulesPointer, UPluralRules, uplrules_close);

U_NAMESPACE_END

#endif


/**
 * Given a floating-point number, returns the keyword of the first rule that
 * applies to the number, according to the supplied UPluralRules object.
 * @param uplrules The UPluralRules object specifying the rules.
 * @param number The number for which the rule has to be determined.
 * @param keyword An output buffer to write the keyword of the rule that
 *         applies to number.
 * @param capacity The capacity of the keyword buffer.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return The length of the keyword.
 * @stable ICU 4.8
 */
U_CAPI int32_t U_EXPORT2
uplrules_select(const UPluralRules *uplrules,
               double number,
               UChar *keyword, int32_t capacity,
               UErrorCode *status);

/**
 * Given a formatted number, returns the keyword of the first rule
 * that applies to the number, according to the supplied UPluralRules object.
 *
 * A UFormattedNumber allows you to specify an exponent or trailing zeros,
 * which can affect the plural category. To get a UFormattedNumber, see
 * {@link UNumberFormatter}.
 *
 * @param uplrules The UPluralRules object specifying the rules.
 * @param number The formatted number for which the rule has to be determined.
 * @param keyword The destination buffer for the keyword of the rule that
 *         applies to the number.
 * @param capacity The capacity of the keyword buffer.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return The length of the keyword.
 * @stable ICU 64
 */
U_CAPI int32_t U_EXPORT2
uplrules_selectFormatted(const UPluralRules *uplrules,
               const struct UFormattedNumber* number,
               UChar *keyword, int32_t capacity,
               UErrorCode *status);

/**
 * Given a formatted number range, returns the overall plural form of the
 * range. For example, "3-5" returns "other" in English.
 *
 * To get a UFormattedNumberRange, see UNumberRangeFormatter.
 *
 * @param uplrules The UPluralRules object specifying the rules.
 * @param urange The number range onto which the rules will be applied.
 * @param keyword The destination buffer for the keyword of the rule that
 *         applies to the number range.
 * @param capacity The capacity of the keyword buffer.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return The length of the keyword.
 * @stable ICU 68
 */
U_CAPI int32_t U_EXPORT2
uplrules_selectForRange(const UPluralRules *uplrules,
               const struct UFormattedNumberRange* urange,
               UChar *keyword, int32_t capacity,
               UErrorCode *status);

#ifndef U_HIDE_INTERNAL_API
/**
 * Given a number, returns the keyword of the first rule that applies to the
 * number, according to the UPluralRules object and given the number format
 * specified by the UNumberFormat object.
 * Note: This internal preview interface may be removed in the future if
 * an architecturally cleaner solution reaches stable status.
 * @param uplrules The UPluralRules object specifying the rules.
 * @param number The number for which the rule has to be determined.
 * @param fmt The UNumberFormat specifying how the number will be formatted
 *        (this can affect the plural form, e.g. "1 dollar" vs "1.0 dollars").
 *        If this is NULL, the function behaves like uplrules_select.
 * @param keyword An output buffer to write the keyword of the rule that
 *         applies to number.
 * @param capacity The capacity of the keyword buffer.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return The length of keyword.
 * @internal ICU 59 technology preview, may be removed in the future
 */
U_CAPI int32_t U_EXPORT2
uplrules_selectWithFormat(const UPluralRules *uplrules,
                          double number,
                          const UNumberFormat *fmt,
                          UChar *keyword, int32_t capacity,
                          UErrorCode *status);

#endif  /* U_HIDE_INTERNAL_API */

/**
 * Creates a string enumeration of all plural rule keywords used in this
 * UPluralRules object. The rule "other" is always present by default.
 * @param uplrules The UPluralRules object specifying the rules for
 *        a given locale.
 * @param status A pointer to a UErrorCode to receive any errors.
 * @return a string enumeration over plural rule keywords, or NULL
 * upon error. The caller is responsible for closing the result.
 * @stable ICU 59
 */
U_CAPI UEnumeration* U_EXPORT2
uplrules_getKeywords(const UPluralRules *uplrules,
                     UErrorCode *status);

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif
