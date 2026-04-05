// © 2022 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __SIMPLENUMBERFORMATTERH__
#define __SIMPLENUMBERFORMATTERH__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/dcfmtsym.h"
#include "unicode/usimplenumberformatter.h"
#include "unicode/formattednumber.h"

/**
 * \file
 * \brief C++ API: Simple number formatting focused on low memory and code size.
 *
 * These functions render locale-aware number strings but without the bells and whistles found in
 * other number formatting APIs such as those in numberformatter.h, like units and currencies.
 *
 * <pre>
 * SimpleNumberFormatter snf = SimpleNumberFormatter::forLocale("de-CH", status);
 * FormattedNumber result = snf.formatInt64(-1000007, status);
 * assertEquals("", u"-1’000’007", result.toString(status));
 * </pre>
 */

U_NAMESPACE_BEGIN

/* forward declaration */
class SimpleDateFormat;

namespace number {  // icu::number


namespace impl {
class UFormattedNumberData;
struct SimpleMicroProps;
class AdoptingSignumModifierStore;
}  // icu::number::impl


/**
 * An input type for SimpleNumberFormatter.
 *
 * This class is mutable and not intended for public subclassing. This class is movable but not copyable.
 *
 * @stable ICU 73
 */
class U_I18N_API SimpleNumber : public UMemory {
  public:
    /**
     * Creates a SimpleNumber for an integer.
     *
     * @stable ICU 73
     */
    static SimpleNumber forInt64(int64_t value, UErrorCode& status);

    /**
     * Changes the value of the SimpleNumber by a power of 10.
     *
     * This function immediately mutates the inner value.
     *
     * @stable ICU 73
     */
    void multiplyByPowerOfTen(int32_t power, UErrorCode& status);

    /**
     * Rounds the value currently stored in the SimpleNumber to the given power of 10,
     * which can be before or after the decimal separator.
     *
     * This function does not change minimum integer digits.
     *
     * @stable ICU 73
     */
    void roundTo(int32_t power, UNumberFormatRoundingMode roundingMode, UErrorCode& status);

    /**
     * Sets the number of integer digits to the given amount, truncating if necessary.
     *
     * @stable ICU 75
     */
    void setMaximumIntegerDigits(uint32_t maximumIntegerDigits, UErrorCode& status);

    /**
     * Pads the beginning of the number with zeros up to the given minimum number of integer digits.
     *
     * @stable ICU 73
     */
    void setMinimumIntegerDigits(uint32_t minimumIntegerDigits, UErrorCode& status);

    /**
     * Pads the end of the number with zeros up to the given minimum number of fraction digits.
     *
     * @stable ICU 73
     */
    void setMinimumFractionDigits(uint32_t minimumFractionDigits, UErrorCode& status);

    /**
     * Sets the sign of the number: an explicit plus sign, explicit minus sign, or no sign.
     *
     * This setting is applied upon formatting the number.
     *
     * NOTE: This does not support accounting sign notation.
     *
     * @stable ICU 73
     */
    void setSign(USimpleNumberSign sign, UErrorCode& status);

    /**
     * Creates a new, empty SimpleNumber that does not contain a value.
     * 
     * NOTE: This number will fail to format; use forInt64() to create a SimpleNumber with a value.
     *
     * @stable ICU 73
     */
    SimpleNumber() = default;

    /**
     * Destruct this SimpleNumber, cleaning up any memory it might own.
     *
     * @stable ICU 73
     */
    ~SimpleNumber() {
        cleanup();
    }

    /**
     * SimpleNumber move constructor.
     *
     * @stable ICU 73
     */
    SimpleNumber(SimpleNumber&& other) noexcept {
        fData = other.fData;
        fSign = other.fSign;
        other.fData = nullptr;
    }

    /**
     * SimpleNumber move assignment.
     *
     * @stable ICU 73
     */
    SimpleNumber& operator=(SimpleNumber&& other) noexcept {
        cleanup();
        fData = other.fData;
        fSign = other.fSign;
        other.fData = nullptr;
        return *this;
    }

  private:
    SimpleNumber(impl::UFormattedNumberData* data, UErrorCode& status);
    SimpleNumber(const SimpleNumber&) = delete;
    SimpleNumber& operator=(const SimpleNumber&) = delete;

    void cleanup();

    impl::UFormattedNumberData* fData = nullptr;
    USimpleNumberSign fSign = UNUM_SIMPLE_NUMBER_NO_SIGN;

    friend class SimpleNumberFormatter;

    // Uses the private constructor to avoid a heap allocation
    friend class icu::SimpleDateFormat;
};


/**
 * A special NumberFormatter focused on smaller binary size and memory use.
 * 
 * SimpleNumberFormatter is capable of basic number formatting, including grouping separators,
 * sign display, and rounding. It is not capable of currencies, compact notation, or units.
 *
 * This class is immutable and not intended for public subclassing. This class is movable but not copyable.
 *
 * @stable ICU 73
 */
class U_I18N_API SimpleNumberFormatter : public UMemory {
  public:
    /**
     * Creates a new SimpleNumberFormatter with all locale defaults.
     *
     * @stable ICU 73
     */
    static SimpleNumberFormatter forLocale(
        const icu::Locale &locale,
        UErrorCode &status);

    /**
     * Creates a new SimpleNumberFormatter, overriding the grouping strategy.
     *
     * @stable ICU 73
     */
    static SimpleNumberFormatter forLocaleAndGroupingStrategy(
        const icu::Locale &locale,
        UNumberGroupingStrategy groupingStrategy,
        UErrorCode &status);

    /**
     * Creates a new SimpleNumberFormatter, overriding the grouping strategy and symbols.
     *
     * IMPORTANT: For efficiency, this function borrows the symbols. The symbols MUST remain valid
     * for the lifetime of the SimpleNumberFormatter.
     *
     * @stable ICU 73
     */
    static SimpleNumberFormatter forLocaleAndSymbolsAndGroupingStrategy(
        const icu::Locale &locale,
        const DecimalFormatSymbols &symbols,
        UNumberGroupingStrategy groupingStrategy,
        UErrorCode &status);

    /**
     * Formats a value using this SimpleNumberFormatter.
     *
     * The SimpleNumber argument is "consumed". A new SimpleNumber object should be created for
     * every formatting operation.
     *
     * @stable ICU 73
     */
    FormattedNumber format(SimpleNumber value, UErrorCode &status) const;

    /**
     * Formats an integer using this SimpleNumberFormatter.
     *
     * For more control over the formatting, use SimpleNumber.
     *
     * @stable ICU 73
     */
    FormattedNumber formatInt64(int64_t value, UErrorCode &status) const {
        return format(SimpleNumber::forInt64(value, status), status);
    }

#ifndef U_HIDE_INTERNAL_API
    /**
     * Run the formatter with the internal types.
     * @internal
     */
    void formatImpl(impl::UFormattedNumberData* data, USimpleNumberSign sign, UErrorCode& status) const;
#endif // U_HIDE_INTERNAL_API

    /**
     * Destruct this SimpleNumberFormatter, cleaning up any memory it might own.
     *
     * @stable ICU 73
     */
    ~SimpleNumberFormatter() {
        cleanup();
    }

    /**
     * Creates a shell, initialized but non-functional SimpleNumberFormatter.
     *
     * @stable ICU 73
     */
    SimpleNumberFormatter() = default;

    /**
     * SimpleNumberFormatter: Move constructor.
     *
     * @stable ICU 73
     */
    SimpleNumberFormatter(SimpleNumberFormatter&& other) noexcept {
        fGroupingStrategy = other.fGroupingStrategy;
        fOwnedSymbols = other.fOwnedSymbols;
        fMicros = other.fMicros;
        fPatternModifier = other.fPatternModifier;
        other.fOwnedSymbols = nullptr;
        other.fMicros = nullptr;
        other.fPatternModifier = nullptr;
    }

    /**
     * SimpleNumberFormatter: Move assignment.
     *
     * @stable ICU 73
     */
    SimpleNumberFormatter& operator=(SimpleNumberFormatter&& other) noexcept {
        cleanup();
        fGroupingStrategy = other.fGroupingStrategy;
        fOwnedSymbols = other.fOwnedSymbols;
        fMicros = other.fMicros;
        fPatternModifier = other.fPatternModifier;
        other.fOwnedSymbols = nullptr;
        other.fMicros = nullptr;
        other.fPatternModifier = nullptr;
        return *this;
    }

  private:
    void initialize(
        const icu::Locale &locale,
        const DecimalFormatSymbols &symbols,
        UNumberGroupingStrategy groupingStrategy,
        UErrorCode &status);

    void cleanup();

    SimpleNumberFormatter(const SimpleNumberFormatter&) = delete;

    SimpleNumberFormatter& operator=(const SimpleNumberFormatter&) = delete;

    UNumberGroupingStrategy fGroupingStrategy = UNUM_GROUPING_AUTO;

    // Owned Pointers:
    DecimalFormatSymbols* fOwnedSymbols = nullptr; // can be empty
    impl::SimpleMicroProps* fMicros = nullptr;
    impl::AdoptingSignumModifierStore* fPatternModifier = nullptr;
};


}  // namespace number
U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __SIMPLENUMBERFORMATTERH__

