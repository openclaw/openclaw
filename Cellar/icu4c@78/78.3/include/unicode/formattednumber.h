// © 2022 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#ifndef __FORMATTEDNUMBER_H__
#define __FORMATTEDNUMBER_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/uobject.h"
#include "unicode/formattedvalue.h"
#include "unicode/measunit.h"
#include "unicode/udisplayoptions.h"

/**
 * \file
 * \brief C API: Formatted number result from various number formatting functions.
 *
 * See also {@link icu::FormattedValue} for additional things you can do with a FormattedNumber.
 */

U_NAMESPACE_BEGIN

class FieldPositionIteratorHandler;
class SimpleDateFormat;

namespace number {  // icu::number

namespace impl {
class DecimalQuantity;
class UFormattedNumberData;
struct UFormattedNumberImpl;
}  // icu::number::impl



/**
 * The result of a number formatting operation. This class allows the result to be exported in several data types,
 * including a UnicodeString and a FieldPositionIterator.
 *
 * Instances of this class are immutable and thread-safe.
 *
 * @stable ICU 60
 */
class U_I18N_API FormattedNumber : public UMemory, public FormattedValue {
  public:

    /**
     * Default constructor; makes an empty FormattedNumber.
     * @stable ICU 64
     */
    FormattedNumber()
        : fData(nullptr), fErrorCode(U_INVALID_STATE_ERROR) {}

    /**
     * Move constructor: Leaves the source FormattedNumber in an undefined state.
     * @stable ICU 62
     */
    FormattedNumber(FormattedNumber&& src) noexcept;

    /**
     * Destruct an instance of FormattedNumber.
     * @stable ICU 60
     */
    virtual ~FormattedNumber() override;

    /** Copying not supported; use move constructor instead. */
    FormattedNumber(const FormattedNumber&) = delete;

    /** Copying not supported; use move assignment instead. */
    FormattedNumber& operator=(const FormattedNumber&) = delete;

    /**
     * Move assignment: Leaves the source FormattedNumber in an undefined state.
     * @stable ICU 62
     */
    FormattedNumber& operator=(FormattedNumber&& src) noexcept;

    // Copybrief: this method is older than the parent method
    /**
     * @copybrief FormattedValue::toString()
     *
     * For more information, see FormattedValue::toString()
     *
     * @stable ICU 62
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
     * @stable ICU 62
     */
    Appendable &appendTo(Appendable& appendable, UErrorCode& status) const override;

    // Copydoc: this method is new in ICU 64
    /** @copydoc FormattedValue::nextPosition() */
    UBool nextPosition(ConstrainedFieldPosition& cfpos, UErrorCode& status) const override;

    /**
     * Export the formatted number as a "numeric string" conforming to the
     * syntax defined in the Decimal Arithmetic Specification, available at
     * http://speleotrove.com/decimal
     *
     * This endpoint is useful for obtaining the exact number being printed
     * after scaling and rounding have been applied by the number formatter.
     *
     * Example call site:
     *
     *     auto decimalNumber = fn.toDecimalNumber<std::string>(status);
     *
     * @tparam StringClass A string class compatible with StringByteSink;
     *         for example, std::string.
     * @param status Set if an error occurs.
     * @return A StringClass containing the numeric string.
     * @stable ICU 65
     */
    template<typename StringClass>
    inline StringClass toDecimalNumber(UErrorCode& status) const;

	/**
     * Gets the resolved output unit.
     *
     * The output unit is dependent upon the localized preferences for the usage
     * specified via NumberFormatterSettings::usage(), and may be a unit with
     * UMEASURE_UNIT_MIXED unit complexity (MeasureUnit::getComplexity()), such
     * as "foot-and-inch" or "hour-and-minute-and-second".
     *
     * @return `MeasureUnit`.
     * @stable ICU 68
     */
    MeasureUnit getOutputUnit(UErrorCode& status) const;

    /**
     * Gets the noun class of the formatted output. Returns `UNDEFINED` when the noun class
     * is not supported yet.
     *
     * @return UDisplayOptionsNounClass
     * @stable ICU 72
     */
    UDisplayOptionsNounClass getNounClass(UErrorCode &status) const;

#ifndef U_HIDE_INTERNAL_API

    /**
     *  Gets the raw DecimalQuantity for plural rule selection.
     *  @internal
     */
    void getDecimalQuantity(impl::DecimalQuantity& output, UErrorCode& status) const;

    /**
     * Populates the mutable builder type FieldPositionIteratorHandler.
     * @internal
     */
    void getAllFieldPositionsImpl(FieldPositionIteratorHandler& fpih, UErrorCode& status) const;

#endif  /* U_HIDE_INTERNAL_API */

  private:
    // Can't use LocalPointer because UFormattedNumberData is forward-declared
    impl::UFormattedNumberData *fData;

    // Error code for the terminal methods
    UErrorCode fErrorCode;

    /**
     * Internal constructor from data type. Adopts the data pointer.
     */
    explicit FormattedNumber(impl::UFormattedNumberData *results)
        : fData(results), fErrorCode(U_ZERO_ERROR) {}

    explicit FormattedNumber(UErrorCode errorCode)
        : fData(nullptr), fErrorCode(errorCode) {}

    void toDecimalNumber(ByteSink& sink, UErrorCode& status) const;

    // To give LocalizedNumberFormatter format methods access to this class's constructor:
    friend class LocalizedNumberFormatter;
    friend class SimpleNumberFormatter;

    // To give C API access to internals
    friend struct impl::UFormattedNumberImpl;

    // To give access to the data pointer for non-heap allocation
    friend class icu::SimpleDateFormat;
};

template<typename StringClass>
StringClass FormattedNumber::toDecimalNumber(UErrorCode& status) const {
    StringClass result;
    StringByteSink<StringClass> sink(&result);
    toDecimalNumber(sink, status);
    return result;
}

}  // namespace number
U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __FORMATTEDNUMBER_H__

