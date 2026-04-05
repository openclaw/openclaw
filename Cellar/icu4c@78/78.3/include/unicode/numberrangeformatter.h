// © 2018 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __NUMBERRANGEFORMATTER_H__
#define __NUMBERRANGEFORMATTER_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include <atomic>
#include "unicode/appendable.h"
#include "unicode/fieldpos.h"
#include "unicode/formattedvalue.h"
#include "unicode/fpositer.h"
#include "unicode/numberformatter.h"
#include "unicode/unumberrangeformatter.h"

/**
 * \file
 * \brief C++ API: Library for localized formatting of number, currency, and unit ranges.
 *
 * The main entrypoint to the formatting of ranges of numbers, including currencies and other units of measurement.
 * <p>
 * Usage example:
 * <p>
 * <pre>
 * NumberRangeFormatter::with()
 *     .identityFallback(UNUM_IDENTITY_FALLBACK_APPROXIMATELY_OR_SINGLE_VALUE)
 *     .numberFormatterFirst(NumberFormatter::with().adoptUnit(MeasureUnit::createMeter()))
 *     .numberFormatterSecond(NumberFormatter::with().adoptUnit(MeasureUnit::createKilometer()))
 *     .locale("en-GB")
 *     .formatFormattableRange(750, 1.2, status)
 *     .toString(status);
 * // => "750 m - 1.2 km"
 * </pre>
 * <p>
 * Like NumberFormatter, NumberRangeFormatter instances (i.e., LocalizedNumberRangeFormatter
 * and UnlocalizedNumberRangeFormatter) are immutable and thread-safe. This API is based on the
 * <em>fluent</em> design pattern popularized by libraries such as Google's Guava.
 *
 * @author Shane Carr
 */


U_NAMESPACE_BEGIN

// Forward declarations:
class PluralRules;

namespace number {  // icu::number

// Forward declarations:
class UnlocalizedNumberRangeFormatter;
class LocalizedNumberRangeFormatter;
class FormattedNumberRange;

namespace impl {

// Forward declarations:
struct RangeMacroProps;
class DecimalQuantity;
class UFormattedNumberRangeData;
class NumberRangeFormatterImpl;
struct UFormattedNumberRangeImpl;

} // namespace impl

// Other helper classes would go here, but there are none.

namespace impl {  // icu::number::impl

// Do not enclose entire MacroProps with #ifndef U_HIDE_INTERNAL_API, needed for a protected field
/** @internal */
struct RangeMacroProps : public UMemory {
    /** @internal */
    UnlocalizedNumberFormatter formatter1; // = NumberFormatter::with();

    /** @internal */
    UnlocalizedNumberFormatter formatter2; // = NumberFormatter::with();

    /** @internal */
    bool singleFormatter = true;

    /** @internal */
    UNumberRangeCollapse collapse = UNUM_RANGE_COLLAPSE_AUTO;

    /** @internal */
    UNumberRangeIdentityFallback identityFallback = UNUM_IDENTITY_FALLBACK_APPROXIMATELY;

    /** @internal */
    Locale locale;

    // NOTE: Uses default copy and move constructors.

    /**
     * Check all members for errors.
     * @internal
     */
    bool copyErrorTo(UErrorCode &status) const {
        return formatter1.copyErrorTo(status) || formatter2.copyErrorTo(status);
    }
};

} // namespace impl

/**
 * An abstract base class for specifying settings related to number formatting. This class is implemented by
 * {@link UnlocalizedNumberRangeFormatter} and {@link LocalizedNumberRangeFormatter}. This class is not intended for
 * public subclassing.
 */
template<typename Derived>
class U_I18N_API NumberRangeFormatterSettings {
  public:
    /**
     * Sets the NumberFormatter instance to use for the numbers in the range. The same formatter is applied to both
     * sides of the range.
     * <p>
     * The NumberFormatter instances must not have a locale applied yet; the locale specified on the
     * NumberRangeFormatter will be used.
     *
     * @param formatter
     *            The formatter to use for both numbers in the range.
     * @return The fluent chain.
     * @stable ICU 63
     */
    Derived numberFormatterBoth(const UnlocalizedNumberFormatter &formatter) const &;

    /**
     * Overload of numberFormatterBoth() for use on an rvalue reference.
     *
     * @param formatter
     *            The formatter to use for both numbers in the range.
     * @return The fluent chain.
     * @see #numberFormatterBoth
     * @stable ICU 63
     */
    Derived numberFormatterBoth(const UnlocalizedNumberFormatter &formatter) &&;

    /**
     * Overload of numberFormatterBoth() for use on an rvalue reference.
     *
     * @param formatter
     *            The formatter to use for both numbers in the range.
     * @return The fluent chain.
     * @see #numberFormatterBoth
     * @stable ICU 63
     */
    Derived numberFormatterBoth(UnlocalizedNumberFormatter &&formatter) const &;

    /**
     * Overload of numberFormatterBoth() for use on an rvalue reference.
     *
     * @param formatter
     *            The formatter to use for both numbers in the range.
     * @return The fluent chain.
     * @see #numberFormatterBoth
     * @stable ICU 63
     */
    Derived numberFormatterBoth(UnlocalizedNumberFormatter &&formatter) &&;

    /**
     * Sets the NumberFormatter instance to use for the first number in the range.
     * <p>
     * The NumberFormatter instances must not have a locale applied yet; the locale specified on the
     * NumberRangeFormatter will be used.
     *
     * @param formatterFirst
     *            The formatter to use for the first number in the range.
     * @return The fluent chain.
     * @stable ICU 63
     */
    Derived numberFormatterFirst(const UnlocalizedNumberFormatter &formatterFirst) const &;

    /**
     * Overload of numberFormatterFirst() for use on an rvalue reference.
     *
     * @param formatterFirst
     *            The formatter to use for the first number in the range.
     * @return The fluent chain.
     * @see #numberFormatterFirst
     * @stable ICU 63
     */
    Derived numberFormatterFirst(const UnlocalizedNumberFormatter &formatterFirst) &&;

    /**
     * Overload of numberFormatterFirst() for use on an rvalue reference.
     *
     * @param formatterFirst
     *            The formatter to use for the first number in the range.
     * @return The fluent chain.
     * @see #numberFormatterFirst
     * @stable ICU 63
     */
    Derived numberFormatterFirst(UnlocalizedNumberFormatter &&formatterFirst) const &;

    /**
     * Overload of numberFormatterFirst() for use on an rvalue reference.
     *
     * @param formatterFirst
     *            The formatter to use for the first number in the range.
     * @return The fluent chain.
     * @see #numberFormatterFirst
     * @stable ICU 63
     */
    Derived numberFormatterFirst(UnlocalizedNumberFormatter &&formatterFirst) &&;

    /**
     * Sets the NumberFormatter instance to use for the second number in the range.
     * <p>
     * The NumberFormatter instances must not have a locale applied yet; the locale specified on the
     * NumberRangeFormatter will be used.
     *
     * @param formatterSecond
     *            The formatter to use for the second number in the range.
     * @return The fluent chain.
     * @stable ICU 63
     */
    Derived numberFormatterSecond(const UnlocalizedNumberFormatter &formatterSecond) const &;

    /**
     * Overload of numberFormatterSecond() for use on an rvalue reference.
     *
     * @param formatterSecond
     *            The formatter to use for the second number in the range.
     * @return The fluent chain.
     * @see #numberFormatterSecond
     * @stable ICU 63
     */
    Derived numberFormatterSecond(const UnlocalizedNumberFormatter &formatterSecond) &&;

    /**
     * Overload of numberFormatterSecond() for use on an rvalue reference.
     *
     * @param formatterSecond
     *            The formatter to use for the second number in the range.
     * @return The fluent chain.
     * @see #numberFormatterSecond
     * @stable ICU 63
     */
    Derived numberFormatterSecond(UnlocalizedNumberFormatter &&formatterSecond) const &;

    /**
     * Overload of numberFormatterSecond() for use on an rvalue reference.
     *
     * @param formatterSecond
     *            The formatter to use for the second number in the range.
     * @return The fluent chain.
     * @see #numberFormatterSecond
     * @stable ICU 63
     */
    Derived numberFormatterSecond(UnlocalizedNumberFormatter &&formatterSecond) &&;

    /**
     * Sets the aggressiveness of "collapsing" fields across the range separator. Possible values:
     * <p>
     * <ul>
     * <li>ALL: "3-5K miles"</li>
     * <li>UNIT: "3K - 5K miles"</li>
     * <li>NONE: "3K miles - 5K miles"</li>
     * <li>AUTO: usually UNIT or NONE, depending on the locale and formatter settings</li>
     * </ul>
     * <p>
     * The default value is AUTO.
     *
     * @param collapse
     *            The collapsing strategy to use for this range.
     * @return The fluent chain.
     * @stable ICU 63
     */
    Derived collapse(UNumberRangeCollapse collapse) const &;

    /**
     * Overload of collapse() for use on an rvalue reference.
     *
     * @param collapse
     *            The collapsing strategy to use for this range.
     * @return The fluent chain.
     * @see #collapse
     * @stable ICU 63
     */
    Derived collapse(UNumberRangeCollapse collapse) &&;

    /**
     * Sets the behavior when the two sides of the range are the same. This could happen if the same two numbers are
     * passed to the formatFormattableRange function, or if different numbers are passed to the function but they
     * become the same after rounding rules are applied. Possible values:
     * <p>
     * <ul>
     * <li>SINGLE_VALUE: "5 miles"</li>
     * <li>APPROXIMATELY_OR_SINGLE_VALUE: "~5 miles" or "5 miles", depending on whether the number was the same before
     * rounding was applied</li>
     * <li>APPROXIMATELY: "~5 miles"</li>
     * <li>RANGE: "5-5 miles" (with collapse=UNIT)</li>
     * </ul>
     * <p>
     * The default value is APPROXIMATELY.
     *
     * @param identityFallback
     *            The strategy to use when formatting two numbers that end up being the same.
     * @return The fluent chain.
     * @stable ICU 63
     */
    Derived identityFallback(UNumberRangeIdentityFallback identityFallback) const &;

    /**
     * Overload of identityFallback() for use on an rvalue reference.
     *
     * @param identityFallback
     *            The strategy to use when formatting two numbers that end up being the same.
     * @return The fluent chain.
     * @see #identityFallback
     * @stable ICU 63
     */
    Derived identityFallback(UNumberRangeIdentityFallback identityFallback) &&;

    /**
     * Returns the current (Un)LocalizedNumberRangeFormatter as a LocalPointer
     * wrapping a heap-allocated copy of the current object.
     *
     * This is equivalent to new-ing the move constructor with a value object
     * as the argument.
     *
     * @return A wrapped (Un)LocalizedNumberRangeFormatter pointer, or a wrapped
     *         nullptr on failure.
     * @stable ICU 64
     */
    LocalPointer<Derived> clone() const &;

    /**
     * Overload of clone for use on an rvalue reference.
     *
     * @return A wrapped (Un)LocalizedNumberRangeFormatter pointer, or a wrapped
     *         nullptr on failure.
     * @stable ICU 64
     */
    LocalPointer<Derived> clone() &&;

    /**
     * Sets the UErrorCode if an error occurred in the fluent chain.
     * Preserves older error codes in the outErrorCode.
     * @return true if U_FAILURE(outErrorCode)
     * @stable ICU 63
     */
    UBool copyErrorTo(UErrorCode &outErrorCode) const {
        if (U_FAILURE(outErrorCode)) {
            // Do not overwrite the older error code
            return true;
        }
        fMacros.copyErrorTo(outErrorCode);
        return U_FAILURE(outErrorCode);
    }

    // NOTE: Uses default copy and move constructors.

  private:
    impl::RangeMacroProps fMacros;

    // Don't construct me directly!  Use (Un)LocalizedNumberFormatter.
    NumberRangeFormatterSettings() = default;

    friend class LocalizedNumberRangeFormatter;
    friend class UnlocalizedNumberRangeFormatter;
};

// Explicit instantiations in source/i18n/numrange_fluent.cpp.
// (MSVC treats imports/exports of explicit instantiations differently.)
#ifndef _MSC_VER
extern template class NumberRangeFormatterSettings<UnlocalizedNumberRangeFormatter>;
extern template class NumberRangeFormatterSettings<LocalizedNumberRangeFormatter>;
#endif

/**
 * A NumberRangeFormatter that does not yet have a locale. In order to format, a locale must be specified.
 *
 * Instances of this class are immutable and thread-safe.
 *
 * @see NumberRangeFormatter
 * @stable ICU 63
 */
class U_I18N_API UnlocalizedNumberRangeFormatter
        : public NumberRangeFormatterSettings<UnlocalizedNumberRangeFormatter>, public UMemory {

  public:
    /**
     * Associate the given locale with the number range formatter. The locale is used for picking the
     * appropriate symbols, formats, and other data for number display.
     *
     * @param locale
     *            The locale to use when loading data for number formatting.
     * @return The fluent chain.
     * @stable ICU 63
     */
    LocalizedNumberRangeFormatter locale(const icu::Locale &locale) const &;

    /**
     * Overload of locale() for use on an rvalue reference.
     *
     * @param locale
     *            The locale to use when loading data for number formatting.
     * @return The fluent chain.
     * @see #locale
     * @stable ICU 63
     */
    LocalizedNumberRangeFormatter locale(const icu::Locale &locale) &&;

    /**
     * Default constructor: puts the formatter into a valid but undefined state.
     *
     * @stable ICU 63
     */
    UnlocalizedNumberRangeFormatter() = default;

    /**
     * Returns a copy of this UnlocalizedNumberRangeFormatter.
     * @stable ICU 63
     */
    UnlocalizedNumberRangeFormatter(const UnlocalizedNumberRangeFormatter &other);

    /**
     * Move constructor:
     * The source UnlocalizedNumberRangeFormatter will be left in a valid but undefined state.
     * @stable ICU 63
     */
    UnlocalizedNumberRangeFormatter(UnlocalizedNumberRangeFormatter&& src) noexcept;

    /**
     * Copy assignment operator.
     * @stable ICU 63
     */
    UnlocalizedNumberRangeFormatter& operator=(const UnlocalizedNumberRangeFormatter& other);

    /**
     * Move assignment operator:
     * The source UnlocalizedNumberRangeFormatter will be left in a valid but undefined state.
     * @stable ICU 63
     */
    UnlocalizedNumberRangeFormatter& operator=(UnlocalizedNumberRangeFormatter&& src) noexcept;

  private:
    explicit UnlocalizedNumberRangeFormatter(
            const NumberRangeFormatterSettings<UnlocalizedNumberRangeFormatter>& other);

    explicit UnlocalizedNumberRangeFormatter(
            NumberRangeFormatterSettings<UnlocalizedNumberRangeFormatter>&& src) noexcept;

    explicit UnlocalizedNumberRangeFormatter(const impl::RangeMacroProps &macros);

    explicit UnlocalizedNumberRangeFormatter(impl::RangeMacroProps &&macros);

    // To give the fluent setters access to this class's constructor:
    friend class NumberRangeFormatterSettings<UnlocalizedNumberRangeFormatter>;

    // To give NumberRangeFormatter::with() access to this class's constructor:
    friend class NumberRangeFormatter;

    // To give LNRF::withoutLocale() access to this class's constructor:
    friend class LocalizedNumberRangeFormatter;
};

/**
 * A NumberRangeFormatter that has a locale associated with it; this means .formatRange() methods are available.
 *
 * Instances of this class are immutable and thread-safe.
 *
 * @see NumberFormatter
 * @stable ICU 63
 */
class U_I18N_API_CLASS LocalizedNumberRangeFormatter
        : public NumberRangeFormatterSettings<LocalizedNumberRangeFormatter>, public UMemory {
  public:
    /**
     * Format the given Formattables to a string using the settings specified in the NumberRangeFormatter fluent setting
     * chain.
     *
     * @param first
     *            The first number in the range, usually to the left in LTR locales.
     * @param second
     *            The second number in the range, usually to the right in LTR locales.
     * @param status
     *            Set if an error occurs while formatting.
     * @return A FormattedNumberRange object; call .toString() to get the string.
     * @stable ICU 63
     */
    U_I18N_API FormattedNumberRange formatFormattableRange(
        const Formattable& first, const Formattable& second, UErrorCode& status) const;

    /**
     * Disassociate the locale from this formatter.
     *
     * @return The fluent chain.
     * @stable ICU 75
     */
    U_I18N_API UnlocalizedNumberRangeFormatter withoutLocale() const &;

    /**
     * Overload of withoutLocale() for use on an rvalue reference.
     *
     * @return The fluent chain.
     * @see #withoutLocale
     * @stable ICU 75
     */
    U_I18N_API UnlocalizedNumberRangeFormatter withoutLocale() &&;

    /**
     * Default constructor: puts the formatter into a valid but undefined state.
     *
     * @stable ICU 63
     */
    U_I18N_API LocalizedNumberRangeFormatter() = default;

    /**
     * Returns a copy of this LocalizedNumberRangeFormatter.
     * @stable ICU 63
     */
    U_I18N_API LocalizedNumberRangeFormatter(const LocalizedNumberRangeFormatter &other);

    /**
     * Move constructor:
     * The source LocalizedNumberRangeFormatter will be left in a valid but undefined state.
     * @stable ICU 63
     */
    U_I18N_API LocalizedNumberRangeFormatter(LocalizedNumberRangeFormatter&& src) noexcept;

    /**
     * Copy assignment operator.
     * @stable ICU 63
     */
    U_I18N_API LocalizedNumberRangeFormatter& operator=(const LocalizedNumberRangeFormatter& other);

    /**
     * Move assignment operator:
     * The source LocalizedNumberRangeFormatter will be left in a valid but undefined state.
     * @stable ICU 63
     */
    U_I18N_API LocalizedNumberRangeFormatter& operator=(LocalizedNumberRangeFormatter&& src) noexcept;

#ifndef U_HIDE_INTERNAL_API

    /**
     * @param results
     *            The results object. This method will mutate it to save the results.
     * @param equalBeforeRounding
     *            Whether the number was equal before copying it into a DecimalQuantity.
     *            Used for determining the identity fallback behavior.
     * @param status
     *            Set if an error occurs while formatting.
     * @internal
     */
    U_I18N_API void formatImpl(impl::UFormattedNumberRangeData &results, bool equalBeforeRounding,
                               UErrorCode &status) const;

#endif  /* U_HIDE_INTERNAL_API */

    /**
     * Destruct this LocalizedNumberRangeFormatter, cleaning up any memory it might own.
     * @stable ICU 63
     */
    U_I18N_API ~LocalizedNumberRangeFormatter();

  private:
    std::atomic<impl::NumberRangeFormatterImpl*> fAtomicFormatter = {};

    const impl::NumberRangeFormatterImpl* getFormatter(UErrorCode& stauts) const;

    explicit LocalizedNumberRangeFormatter(
        const NumberRangeFormatterSettings<LocalizedNumberRangeFormatter>& other);

    explicit LocalizedNumberRangeFormatter(
        NumberRangeFormatterSettings<LocalizedNumberRangeFormatter>&& src) noexcept;

    LocalizedNumberRangeFormatter(const impl::RangeMacroProps &macros, const Locale &locale);

    LocalizedNumberRangeFormatter(impl::RangeMacroProps &&macros, const Locale &locale);

    // To give the fluent setters access to this class's constructor:
    friend class NumberRangeFormatterSettings<UnlocalizedNumberRangeFormatter>;
    friend class NumberRangeFormatterSettings<LocalizedNumberRangeFormatter>;

    // To give UnlocalizedNumberRangeFormatter::locale() access to this class's constructor:
    friend class UnlocalizedNumberRangeFormatter;
};

/**
 * The result of a number range formatting operation. This class allows the result to be exported in several data types,
 * including a UnicodeString and a FieldPositionIterator.
 *
 * Instances of this class are immutable and thread-safe.
 *
 * @stable ICU 63
 */
class U_I18N_API FormattedNumberRange : public UMemory, public FormattedValue {
  public:
    // Copybrief: this method is older than the parent method
    /**
     * @copybrief FormattedValue::toString()
     *
     * For more information, see FormattedValue::toString()
     *
     * @stable ICU 63
     */
    UnicodeString toString(UErrorCode& status) const override;

    // Copydoc: this method is new in ICU 64
    /** @copydoc FormattedValue::toTempString() */
    UnicodeString toTempString(UErrorCode& status) const override;

    // Copybrief: this method is older than the parent method
    /**
     * @copybrief FormattedValue::appendTo()
     *
     * For more information, see FormattedValue::appendTo()
     *
     * @stable ICU 63
     */
    Appendable &appendTo(Appendable &appendable, UErrorCode& status) const override;

    // Copydoc: this method is new in ICU 64
    /** @copydoc FormattedValue::nextPosition() */
    UBool nextPosition(ConstrainedFieldPosition& cfpos, UErrorCode& status) const override;

    /**
     * Extracts the formatted range as a pair of decimal numbers. This endpoint
     * is useful for obtaining the exact number being printed after scaling
     * and rounding have been applied by the number range formatting pipeline.
     * 
     * The syntax of the unformatted numbers is a "numeric string"
     * as defined in the Decimal Arithmetic Specification, available at
     * http://speleotrove.com/decimal
     *
     * Example C++17 call site:
     *
     *     auto [ first, second ] = range.getDecimalNumbers<std::string>(status);
     *
     * @tparam StringClass A string class compatible with StringByteSink;
     *         for example, std::string.
     * @param status Set if an error occurs.
     * @return A pair of StringClasses containing the numeric strings.
     * @stable ICU 68
     */
    template<typename StringClass>
    inline std::pair<StringClass, StringClass> getDecimalNumbers(UErrorCode& status) const;

    /**
     * Returns whether the pair of numbers was successfully formatted as a range or whether an identity fallback was
     * used. For example, if the first and second number were the same either before or after rounding occurred, an
     * identity fallback was used.
     *
     * @return An indication the resulting identity situation in the formatted number range.
     * @stable ICU 63
     * @see UNumberRangeIdentityFallback
     */
    UNumberRangeIdentityResult getIdentityResult(UErrorCode& status) const;

    /**
     * Default constructor; makes an empty FormattedNumberRange.
     * @stable ICU 70
     */
    FormattedNumberRange()
        : fData(nullptr), fErrorCode(U_INVALID_STATE_ERROR) {}

    /**
     * Copying not supported; use move constructor instead.
     */
    FormattedNumberRange(const FormattedNumberRange&) = delete;

    /**
     * Copying not supported; use move assignment instead.
     */
    FormattedNumberRange& operator=(const FormattedNumberRange&) = delete;

    /**
     * Move constructor:
     * Leaves the source FormattedNumberRange in an undefined state.
     * @stable ICU 63
     */
    FormattedNumberRange(FormattedNumberRange&& src) noexcept;

    /**
     * Move assignment:
     * Leaves the source FormattedNumberRange in an undefined state.
     * @stable ICU 63
     */
    FormattedNumberRange& operator=(FormattedNumberRange&& src) noexcept;

    /**
     * Destruct an instance of FormattedNumberRange, cleaning up any memory it might own.
     * @stable ICU 63
     */
    ~FormattedNumberRange();

  private:
    // Can't use LocalPointer because UFormattedNumberRangeData is forward-declared
    const impl::UFormattedNumberRangeData *fData;

    // Error code for the terminal methods
    UErrorCode fErrorCode;

    /**
     * Internal constructor from data type. Adopts the data pointer.
     */
    explicit FormattedNumberRange(impl::UFormattedNumberRangeData *results)
        : fData(results), fErrorCode(U_ZERO_ERROR) {}

    explicit FormattedNumberRange(UErrorCode errorCode)
        : fData(nullptr), fErrorCode(errorCode) {}

    void getDecimalNumbers(ByteSink& sink1, ByteSink& sink2, UErrorCode& status) const;

    const impl::UFormattedNumberRangeData* getData(UErrorCode& status) const;

    // To allow PluralRules to access the underlying data
    friend class ::icu::PluralRules;

    // To give LocalizedNumberRangeFormatter format methods access to this class's constructor:
    friend class LocalizedNumberRangeFormatter;

    // To give C API access to internals
    friend struct impl::UFormattedNumberRangeImpl;
};

// inline impl of @stable ICU 68 method
template<typename StringClass>
std::pair<StringClass, StringClass> FormattedNumberRange::getDecimalNumbers(UErrorCode& status) const {
    StringClass str1;
    StringClass str2;
    StringByteSink<StringClass> sink1(&str1);
    StringByteSink<StringClass> sink2(&str2);
    getDecimalNumbers(sink1, sink2, status);
    return std::make_pair(str1, str2);
}

/**
 * See the main description in numberrangeformatter.h for documentation and examples.
 *
 * @stable ICU 63
 */
class U_I18N_API NumberRangeFormatter final {
  public:
    /**
     * Call this method at the beginning of a NumberRangeFormatter fluent chain in which the locale is not currently
     * known at the call site.
     *
     * @return An {@link UnlocalizedNumberRangeFormatter}, to be used for chaining.
     * @stable ICU 63
     */
    static UnlocalizedNumberRangeFormatter with();

    /**
     * Call this method at the beginning of a NumberRangeFormatter fluent chain in which the locale is known at the call
     * site.
     *
     * @param locale
     *            The locale from which to load formats and symbols for number range formatting.
     * @return A {@link LocalizedNumberRangeFormatter}, to be used for chaining.
     * @stable ICU 63
     */
    static LocalizedNumberRangeFormatter withLocale(const Locale &locale);

    /**
     * Use factory methods instead of the constructor to create a NumberFormatter.
     */
    NumberRangeFormatter() = delete;
};

}  // namespace number
U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __NUMBERRANGEFORMATTER_H__

