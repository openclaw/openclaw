// © 2022 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __USIMPLENUMBERFORMATTER_H__
#define __USIMPLENUMBERFORMATTER_H__

#include "unicode/utypes.h"

#if !UCONFIG_NO_FORMATTING

#include "unicode/uformattednumber.h"
#include "unicode/unumberoptions.h"

/**
 * \file
 * \brief C API: Simple number formatting focused on low memory and code size.
 *
 * These functions render locale-aware number strings but without the bells and whistles found in
 * other number formatting APIs such as those in unumberformatter.h, like units and currencies.
 *
 * Example using C++ helpers:
 *
 * <pre>
 * LocalUSimpleNumberFormatterPointer uformatter(usnumf_openForLocale("de-CH", status));
 * LocalUFormattedNumberPointer uresult(unumf_openResult(status));
 * usnumf_formatInt64(uformatter.getAlias(), 55, uresult.getAlias(), status);
 * assertEquals("",
 *     u"55",
 *     ufmtval_getString(unumf_resultAsValue(uresult.getAlias(), status), nullptr, status));
 * </pre>
 *
 * Example using pure C:
 * 
 * <pre>
 * UErrorCode ec = U_ZERO_ERROR;
 * USimpleNumberFormatter* uformatter = usnumf_openForLocale("bn", &ec);
 * USimpleNumber* unumber = usnum_openForInt64(1000007, &ec);
 * UFormattedNumber* uresult = unumf_openResult(&ec);
 * usnumf_format(uformatter, unumber, uresult, &ec);
 * int32_t len;
 * const UChar* str = ufmtval_getString(unumf_resultAsValue(uresult, &ec), &len, &ec);
 * if (assertSuccess("Formatting end-to-end", &ec)) {
 *     assertUEquals("Should produce a result in Bangla digits", u"১০,০০,০০৭", str);
 * }

 * // Cleanup:
 * unumf_closeResult(uresult);
 * usnum_close(unumber);
 * usnumf_close(uformatter);
 * </pre>
 */

/**
 * An explicit sign option for a SimpleNumber.
 *
 * @stable ICU 73
 */
typedef enum USimpleNumberSign {
    /**
     * Render a plus sign.
     *
     * @stable ICU 73
     */
    UNUM_SIMPLE_NUMBER_PLUS_SIGN,
    /**
     * Render no sign.
     *
     * @stable ICU 73
     */
    UNUM_SIMPLE_NUMBER_NO_SIGN,
    /**
     * Render a minus sign.
     *
     * @stable ICU 73
     */
    UNUM_SIMPLE_NUMBER_MINUS_SIGN,
} USimpleNumberSign;


struct USimpleNumber;
/**
 * C-compatible version of icu::number::SimpleNumber.
 *
 * @stable ICU 73
 */
typedef struct USimpleNumber USimpleNumber;


struct USimpleNumberFormatter;
/**
 * C-compatible version of icu::number::SimpleNumberFormatter.
 *
 * @stable ICU 73
 */
typedef struct USimpleNumberFormatter USimpleNumberFormatter;


/**
 * Creates a new USimpleNumber to be formatted with a USimpleNumberFormatter.
 *
 * @stable ICU 73
 */
U_CAPI USimpleNumber* U_EXPORT2
usnum_openForInt64(int64_t value, UErrorCode* ec);


/**
 * Overwrites the value in a USimpleNumber to an int64_t.
 *
 * This can be used to reset the number value after formatting.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnum_setToInt64(USimpleNumber* unumber, int64_t value, UErrorCode* ec);


/**
 * Changes the value of the USimpleNumber by a power of 10.
 *
 * This function immediately mutates the inner value.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnum_multiplyByPowerOfTen(USimpleNumber* unumber, int32_t power, UErrorCode* ec);


/**
 * Rounds the value currently stored in the USimpleNumber to the given power of 10,
 * which can be before or after the decimal separator.
 *
 * This function does not change minimum integer digits.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnum_roundTo(USimpleNumber* unumber, int32_t power, UNumberFormatRoundingMode roundingMode, UErrorCode* ec);


/**
 * Pads the beginning of the number with zeros up to the given minimum number of integer digits.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnum_setMinimumIntegerDigits(USimpleNumber* unumber, int32_t minimumIntegerDigits, UErrorCode* ec);


/**
 * Pads the end of the number with zeros up to the given minimum number of fraction digits.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnum_setMinimumFractionDigits(USimpleNumber* unumber, int32_t minimumFractionDigits, UErrorCode* ec);


/**
 * Sets the number of integer digits to the given amount, truncating if necessary.
 *
 * @stable ICU 75
 */
U_CAPI void U_EXPORT2
usnum_setMaximumIntegerDigits(USimpleNumber* unumber, int32_t maximumIntegerDigits, UErrorCode* ec);


/**
 * Sets the sign of the number: an explicit plus sign, explicit minus sign, or no sign.
 *
 * This setting is applied upon formatting the number.
 *
 * NOTE: This does not support accounting sign notation.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnum_setSign(USimpleNumber* unumber, USimpleNumberSign sign, UErrorCode* ec);


/**
 * Creates a new USimpleNumberFormatter with all locale defaults.
 *
 * @stable ICU 73
 */
U_CAPI USimpleNumberFormatter* U_EXPORT2
usnumf_openForLocale(const char* locale, UErrorCode* ec);


/**
 * Creates a new USimpleNumberFormatter, overriding the grouping strategy.
 *
 * @stable ICU 73
 */
U_CAPI USimpleNumberFormatter* U_EXPORT2
usnumf_openForLocaleAndGroupingStrategy(
       const char* locale, UNumberGroupingStrategy groupingStrategy, UErrorCode* ec);


/**
 * Formats a number using this SimpleNumberFormatter.
 *
 * The USimpleNumber is cleared after calling this function. It can be re-used via
 * usnum_setToInt64.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnumf_format(
    const USimpleNumberFormatter* uformatter,
    USimpleNumber* unumber,
    UFormattedNumber* uresult,
    UErrorCode* ec);


/**
 * Formats an integer using this SimpleNumberFormatter.
 *
 * For more control over the formatting, use USimpleNumber.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnumf_formatInt64(
    const USimpleNumberFormatter* uformatter,
    int64_t value,
    UFormattedNumber* uresult,
    UErrorCode* ec);


/**
 * Frees the memory held by a USimpleNumber.
 *
 * NOTE: Normally, a USimpleNumber should be adopted by usnumf_formatAndAdoptNumber.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnum_close(USimpleNumber* unumber);


/**
 * Frees the memory held by a USimpleNumberFormatter.
 *
 * @stable ICU 73
 */
U_CAPI void U_EXPORT2
usnumf_close(USimpleNumberFormatter* uformatter);


#if U_SHOW_CPLUSPLUS_API
U_NAMESPACE_BEGIN

/**
 * \class LocalUSimpleNumberPointer
 * "Smart pointer" class; closes a USimpleNumber via usnum_close().
 * For most methods see the LocalPointerBase base class.
 *
 * NOTE: Normally, a USimpleNumber should be adopted by usnumf_formatAndAdoptNumber.
 * If you use LocalUSimpleNumberPointer, call `.orphan()` when passing to that function.
 *
 * Usage:
 * <pre>
 * LocalUSimpleNumberPointer uformatter(usnumf_openForInteger(...));
 * // no need to explicitly call usnum_close()
 * </pre>
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 73
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUSimpleNumberPointer, USimpleNumber, usnum_close);

/**
 * \class LocalUSimpleNumberFormatterPointer
 * "Smart pointer" class; closes a USimpleNumberFormatter via usnumf_close().
 * For most methods see the LocalPointerBase base class.
 *
 * Usage:
 * <pre>
 * LocalUSimpleNumberFormatterPointer uformatter(usnumf_openForLocale(...));
 * // no need to explicitly call usnumf_close()
 * </pre>
 *
 * @see LocalPointerBase
 * @see LocalPointer
 * @stable ICU 73
 */
U_DEFINE_LOCAL_OPEN_POINTER(LocalUSimpleNumberFormatterPointer, USimpleNumberFormatter, usnumf_close);

U_NAMESPACE_END
#endif // U_SHOW_CPLUSPLUS_API

#endif /* #if !UCONFIG_NO_FORMATTING */
#endif //__USIMPLENUMBERFORMATTER_H__
