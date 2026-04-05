// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
* Copyright (c) 2004-2016, International Business Machines
* Corporation and others.  All Rights Reserved.
**********************************************************************
* Author: Alan Liu
* Created: April 26, 2004
* Since: ICU 3.0
**********************************************************************
*/
#ifndef __MEASUREUNIT_H__
#define __MEASUREUNIT_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include <utility>
#include "unicode/unistr.h"
#include "unicode/localpointer.h"

/**
 * \file
 * \brief C++ API: A unit for measuring a quantity.
 */

U_NAMESPACE_BEGIN

class StringEnumeration;
class MeasureUnitImpl;

namespace number::impl {
class LongNameHandler;
} // namespace number::impl

/**
 * Enumeration for unit complexity. There are three levels:
 *
 * - SINGLE: A single unit, optionally with a power and/or SI or binary prefix.
 *           Examples: hectare, square-kilometer, kilojoule, per-second, mebibyte.
 * - COMPOUND: A unit composed of the product of multiple single units. Examples:
 *             meter-per-second, kilowatt-hour, kilogram-meter-per-square-second.
 * - MIXED: A unit composed of the sum of multiple single units. Examples: foot+inch,
 *          hour+minute+second, degree+arcminute+arcsecond.
 *
 * The complexity determines which operations are available. For example, you cannot set the power
 * or prefix of a compound unit.
 *
 * @stable ICU 67
 */
enum UMeasureUnitComplexity {
    /**
     * A single unit, like kilojoule.
     *
     * @stable ICU 67
     */
    UMEASURE_UNIT_SINGLE,

    /**
     * A compound unit, like meter-per-second.
     *
     * @stable ICU 67
     */
    UMEASURE_UNIT_COMPOUND,

    /**
     * A mixed unit, like hour+minute.
     *
     * @stable ICU 67
     */
    UMEASURE_UNIT_MIXED
};


/**
 * Enumeration for SI and binary prefixes, e.g. "kilo-", "nano-", "mebi-".
 *
 * Enum values should be treated as opaque: use umeas_getPrefixPower() and
 * umeas_getPrefixBase() to find their corresponding values.
 *
 * @stable ICU 69
 * @see umeas_getPrefixBase
 * @see umeas_getPrefixPower
 */
typedef enum UMeasurePrefix {
    /**
     * The absence of an SI or binary prefix.
     *
     * The integer representation of this enum value is an arbitrary
     * implementation detail and should not be relied upon: use
     * umeas_getPrefixPower() to obtain meaningful values.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_ONE = 30 + 0,

    /**
     * SI prefix: yotta, 10^24.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_YOTTA = UMEASURE_PREFIX_ONE + 24,

    /**
     * SI prefix: ronna, 10^27.
     *
     * @stable ICU 75
     */
    UMEASURE_PREFIX_RONNA = UMEASURE_PREFIX_ONE + 27,

    /**
     * SI prefix: quetta, 10^30.
     *
     * @stable ICU 75
     */
    UMEASURE_PREFIX_QUETTA = UMEASURE_PREFIX_ONE + 30,

#ifndef U_HIDE_INTERNAL_API
    /**
     * ICU use only.
     * Used to determine the set of base-10 SI prefixes.
     * @internal
     */
#ifndef U_HIDE_DRAFT_API
    UMEASURE_PREFIX_INTERNAL_MAX_SI = UMEASURE_PREFIX_QUETTA,
#else  /* U_HIDE_DRAFT_API */
    UMEASURE_PREFIX_INTERNAL_MAX_SI = UMEASURE_PREFIX_YOTTA,
#endif  /* U_HIDE_DRAFT_API */

#endif  /* U_HIDE_INTERNAL_API */

    /**
     * SI prefix: zetta, 10^21.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_ZETTA = UMEASURE_PREFIX_ONE + 21,

    /**
     * SI prefix: exa, 10^18.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_EXA = UMEASURE_PREFIX_ONE + 18,

    /**
     * SI prefix: peta, 10^15.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_PETA = UMEASURE_PREFIX_ONE + 15,

    /**
     * SI prefix: tera, 10^12.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_TERA = UMEASURE_PREFIX_ONE + 12,

    /**
     * SI prefix: giga, 10^9.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_GIGA = UMEASURE_PREFIX_ONE + 9,

    /**
     * SI prefix: mega, 10^6.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_MEGA = UMEASURE_PREFIX_ONE + 6,

    /**
     * SI prefix: kilo, 10^3.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_KILO = UMEASURE_PREFIX_ONE + 3,

    /**
     * SI prefix: hecto, 10^2.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_HECTO = UMEASURE_PREFIX_ONE + 2,

    /**
     * SI prefix: deka, 10^1.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_DEKA = UMEASURE_PREFIX_ONE + 1,

    /**
     * SI prefix: deci, 10^-1.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_DECI = UMEASURE_PREFIX_ONE + -1,

    /**
     * SI prefix: centi, 10^-2.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_CENTI = UMEASURE_PREFIX_ONE + -2,

    /**
     * SI prefix: milli, 10^-3.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_MILLI = UMEASURE_PREFIX_ONE + -3,

    /**
     * SI prefix: micro, 10^-6.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_MICRO = UMEASURE_PREFIX_ONE + -6,

    /**
     * SI prefix: nano, 10^-9.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_NANO = UMEASURE_PREFIX_ONE + -9,

    /**
     * SI prefix: pico, 10^-12.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_PICO = UMEASURE_PREFIX_ONE + -12,

    /**
     * SI prefix: femto, 10^-15.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_FEMTO = UMEASURE_PREFIX_ONE + -15,

    /**
     * SI prefix: atto, 10^-18.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_ATTO = UMEASURE_PREFIX_ONE + -18,

    /**
     * SI prefix: zepto, 10^-21.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_ZEPTO = UMEASURE_PREFIX_ONE + -21,

    /**
     * SI prefix: yocto, 10^-24.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_YOCTO = UMEASURE_PREFIX_ONE + -24,

    /**
     * SI prefix: ronto, 10^-27.
     *
     * @stable ICU 75
     */
    UMEASURE_PREFIX_RONTO = UMEASURE_PREFIX_ONE + -27,

    /**
     * SI prefix: quecto, 10^-30.
     *
     * @stable ICU 75
     */
    UMEASURE_PREFIX_QUECTO = UMEASURE_PREFIX_ONE + -30,

#ifndef U_HIDE_INTERNAL_API
    /**
     * ICU use only.
     * Used to determine the set of base-10 SI prefixes.
     * @internal
     */
#ifndef U_HIDE_DRAFT_API
    UMEASURE_PREFIX_INTERNAL_MIN_SI = UMEASURE_PREFIX_QUECTO,
#else  /* U_HIDE_DRAFT_API */
    UMEASURE_PREFIX_INTERNAL_MIN_SI = UMEASURE_PREFIX_YOCTO,
#endif  /* U_HIDE_DRAFT_API */

#endif  // U_HIDE_INTERNAL_API

    // Cannot conditionalize the following with #ifndef U_HIDE_INTERNAL_API,
    // used in definitions of non-internal enum values
    /**
     * ICU use only.
     * Sets the arbitrary offset of the base-1024 binary prefixes' enum values.
     * @internal
     */
    UMEASURE_PREFIX_INTERNAL_ONE_BIN = -60,

    /**
     * Binary prefix: kibi, 1024^1.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_KIBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 1,

#ifndef U_HIDE_INTERNAL_API
    /**
     * ICU use only.
     * Used to determine the set of base-1024 binary prefixes.
     * @internal
     */
    UMEASURE_PREFIX_INTERNAL_MIN_BIN = UMEASURE_PREFIX_KIBI,
#endif  // U_HIDE_INTERNAL_API

    /**
     * Binary prefix: mebi, 1024^2.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_MEBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 2,

    /**
     * Binary prefix: gibi, 1024^3.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_GIBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 3,

    /**
     * Binary prefix: tebi, 1024^4.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_TEBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 4,

    /**
     * Binary prefix: pebi, 1024^5.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_PEBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 5,

    /**
     * Binary prefix: exbi, 1024^6.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_EXBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 6,

    /**
     * Binary prefix: zebi, 1024^7.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_ZEBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 7,

    /**
     * Binary prefix: yobi, 1024^8.
     *
     * @stable ICU 69
     */
    UMEASURE_PREFIX_YOBI = UMEASURE_PREFIX_INTERNAL_ONE_BIN + 8,

#ifndef U_HIDE_INTERNAL_API
    /**
     * ICU use only.
     * Used to determine the set of base-1024 binary prefixes.
     * @internal
     */
    UMEASURE_PREFIX_INTERNAL_MAX_BIN = UMEASURE_PREFIX_YOBI,
#endif  // U_HIDE_INTERNAL_API
} UMeasurePrefix;

/**
 * Returns the base of the factor associated with the given unit prefix: the
 * base is 10 for SI prefixes (kilo, micro) and 1024 for binary prefixes (kibi,
 * mebi).
 *
 * @stable ICU 69
 */
U_CAPI int32_t U_EXPORT2 umeas_getPrefixBase(UMeasurePrefix unitPrefix);

/**
 * Returns the exponent of the factor associated with the given unit prefix, for
 * example 3 for kilo, -6 for micro, 1 for kibi, 2 for mebi, 3 for gibi.
 *
 * @stable ICU 69
 */
U_CAPI int32_t U_EXPORT2 umeas_getPrefixPower(UMeasurePrefix unitPrefix);

/**
 * A unit such as length, mass, volume, currency, etc.  A unit is
 * coupled with a numeric amount to produce a Measure.
 *
 * @author Alan Liu
 * @stable ICU 3.0
 */
class U_I18N_API MeasureUnit: public UObject {
 public:

    /**
     * Default constructor.
     * Populates the instance with the base dimensionless unit, which means that there will be
     * no unit on the formatted number.
     * @stable ICU 3.0
     */
    MeasureUnit();

    /**
     * Copy constructor.
     * @stable ICU 3.0
     */
    MeasureUnit(const MeasureUnit &other);

    /**
     * Move constructor.
     * @stable ICU 67
     */
    MeasureUnit(MeasureUnit &&other) noexcept;

    /**
     * Constructs a MeasureUnit from a CLDR Core Unit Identifier, as defined in UTS 35.
     * This method supports core unit identifiers and mixed unit identifiers.
     * It validates and canonicalizes the given identifier.
     *
     *
     * Example usage:
     * <pre>
     * MeasureUnit example = MeasureUnit::forIdentifier("meter-per-second", status);
     * </pre>
     *
     * @param identifier the CLDR Unit Identifier
     * @param status Set error if the identifier is invalid.
     * @return the corresponding MeasureUnit
     * @stable ICU 67
     */
    static MeasureUnit forIdentifier(StringPiece identifier, UErrorCode& status);

    /**
     * Copy assignment operator.
     * @stable ICU 3.0
     */
    MeasureUnit &operator=(const MeasureUnit &other);

    /**
     * Move assignment operator.
     * @stable ICU 67
     */
    MeasureUnit &operator=(MeasureUnit &&other) noexcept;

    /**
     * Returns a polymorphic clone of this object.  The result will
     * have the same class as returned by getDynamicClassID().
     * @stable ICU 3.0
     */
    virtual MeasureUnit* clone() const;

    /**
     * Destructor
     * @stable ICU 3.0
     */
    virtual ~MeasureUnit();

    /**
     * Equality operator.  Return true if this object is equal
     * to the given object.
     * @stable ICU 3.0
     */
    virtual bool operator==(const UObject& other) const;

    /**
     * Inequality operator.  Return true if this object is not equal
     * to the given object.
     * @stable ICU 53
     */
    bool operator!=(const UObject& other) const {
        return !(*this == other);
    }

    /**
     * Get the type.
     *
     * If the unit does not have a type, the empty string is returned.
     *
     * @stable ICU 53
     */
    const char *getType() const;

    /**
     * Get the sub type.
     *
     * If the unit does not have a subtype, the empty string is returned.
     *
     * @stable ICU 53
     */
    const char *getSubtype() const;

    /**
     * Get CLDR Unit Identifier for this MeasureUnit, as defined in UTS 35.
     *
     * @return The string form of this unit, owned by this MeasureUnit.
     * @stable ICU 67
     */
    const char* getIdentifier() const;

    /**
     * Compute the complexity of the unit. See UMeasureUnitComplexity for more information.
     *
     * @param status Set if an error occurs.
     * @return The unit complexity.
     * @stable ICU 67
     */
    UMeasureUnitComplexity getComplexity(UErrorCode& status) const;

    /**
     * Creates a MeasureUnit which is this SINGLE unit augmented with the specified prefix.
     * For example, UMEASURE_PREFIX_KILO for "kilo", or UMEASURE_PREFIX_KIBI for "kibi".
     *
     * There is sufficient locale data to format all standard prefixes.
     *
     * NOTE: Only works on SINGLE units. If this is a COMPOUND or MIXED unit, an error will
     * occur. For more information, see UMeasureUnitComplexity.
     *
     * @param prefix The prefix, from UMeasurePrefix.
     * @param status Set if this is not a SINGLE unit or if another error occurs.
     * @return A new SINGLE unit.
     * @stable ICU 69
     */
    MeasureUnit withPrefix(UMeasurePrefix prefix, UErrorCode& status) const;

    /**
     * Returns the current SI or binary prefix of this SINGLE unit. For example,
     * if the unit has the prefix "kilo", then UMEASURE_PREFIX_KILO is
     * returned.
     *
     * NOTE: Only works on SINGLE units. If this is a COMPOUND or MIXED unit, an error will
     * occur. For more information, see UMeasureUnitComplexity.
     *
     * @param status Set if this is not a SINGLE unit or if another error occurs.
     * @return The prefix of this SINGLE unit, from UMeasurePrefix.
     * @see umeas_getPrefixBase
     * @see umeas_getPrefixPower
     * @stable ICU 69
     */
    UMeasurePrefix getPrefix(UErrorCode& status) const;

#ifndef U_HIDE_DRAFT_API

    /**
     * Creates a new MeasureUnit with a specified constant denominator.
     *
     * This method is applicable only to COMPOUND and SINGLE units. If invoked on a
     * MIXED unit, an error will be set in the status.
     *
     * NOTE: If the constant denominator is set to 0, it means that you are removing
     * the constant denominator.
     *
     * @param denominator The constant denominator to set.
     * @param status Set if this is not a COMPOUND or SINGLE unit or if another error occurs.
     * @return A new MeasureUnit with the specified constant denominator.
     * @draft ICU 77
     */
    MeasureUnit withConstantDenominator(uint64_t denominator, UErrorCode &status) const;

    /**
     * Retrieves the constant denominator for this COMPOUND unit.
     *
     * Examples:
     * - For the unit "liter-per-1000-kiloliter", the constant denominator is 1000.
     * - For the unit "liter-per-kilometer", the constant denominator is zero.
     *
     * This method is applicable only to COMPOUND and SINGLE units. If invoked on
     * a MIXED unit, an error will be set in the status.
     *
     * NOTE: If no constant denominator exists, the method returns 0.
     *
     * @param status Set if this is not a COMPOUND or SINGLE unit or if another error occurs.
     * @return The value of the constant denominator.
     * @draft ICU 77
     */
    uint64_t getConstantDenominator(UErrorCode &status) const;

#endif /* U_HIDE_DRAFT_API */

    /**
     * Creates a MeasureUnit which is this SINGLE unit augmented with the specified dimensionality
     * (power). For example, if dimensionality is 2, the unit will be squared.
     *
     * NOTE: Only works on SINGLE units. If this is a COMPOUND or MIXED unit, an error will
     * occur. For more information, see UMeasureUnitComplexity.
     *
     * For the base dimensionless unit, withDimensionality does nothing.
     *
     * @param dimensionality The dimensionality (power).
     * @param status Set if this is not a SINGLE unit or if another error occurs.
     * @return A new SINGLE unit.
     * @stable ICU 67
     */
    MeasureUnit withDimensionality(int32_t dimensionality, UErrorCode& status) const;

    /**
     * Gets the dimensionality (power) of this MeasureUnit. For example, if the unit is square,
     * then 2 is returned.
     *
     * NOTE: Only works on SINGLE units. If this is a COMPOUND or MIXED unit, an error will
     * occur. For more information, see UMeasureUnitComplexity.
     *
     * For the base dimensionless unit, getDimensionality returns 0.
     *
     * @param status Set if this is not a SINGLE unit or if another error occurs.
     * @return The dimensionality (power) of this simple unit.
     * @stable ICU 67
     */
    int32_t getDimensionality(UErrorCode& status) const;

    /**
     * Gets the reciprocal of this MeasureUnit, with the numerator and denominator flipped.
     *
     * For example, if the receiver is "meter-per-second", the unit "second-per-meter" is returned.
     *
     * NOTE: Only works on SINGLE and COMPOUND units. If this is a MIXED unit, an error will
     * occur. For more information, see UMeasureUnitComplexity.
     *
     * NOTE: An Error will be returned for units that have a constant denominator.
     *
     * @param status Set if this is a MIXED unit, has a constant denominator or if another error occurs.
     * @return The reciprocal of the target unit.
     * @stable ICU 67
     */
    MeasureUnit reciprocal(UErrorCode& status) const;

    /**
     * Gets the product of this unit with another unit. This is a way to build units from
     * constituent parts.
     *
     * The numerator and denominator are preserved through this operation.
     *
     * For example, if the receiver is "kilowatt" and the argument is "hour-per-day", then the
     * unit "kilowatt-hour-per-day" is returned.
     *
     * NOTE: Only works on SINGLE and COMPOUND units. If either unit (receiver and argument) is a
     * MIXED unit, an error will occur. For more information, see UMeasureUnitComplexity.
     *
     * @param other The MeasureUnit to multiply with the target.
     * @param status Set if this or other is a MIXED unit or if another error occurs.
     * @return The product of the target unit with the provided unit.
     * @stable ICU 67
     */
    MeasureUnit product(const MeasureUnit& other, UErrorCode& status) const;

    /**
     * Gets the list of SINGLE units contained within a MIXED or COMPOUND unit.
     *
     * Examples:
     * - Given "meter-kilogram-per-second", three units will be returned: "meter",
     *   "kilogram", and "per-second".
     * - Given "hour+minute+second", three units will be returned: "hour", "minute",
     *   and "second".
     *
     * If this is a SINGLE unit, an array of length 1 will be returned.
     *
     * NOTE: For units with a constant denominator, the returned single units will
     * not include the constant denominator. To obtain the constant denominator,
     * retrieve it from the original unit.
     *
     * @param status Set if an error occurs.
     * @return A pair with the list of units as a LocalArray and the number of units in the list.
     * @stable ICU 68
     */
    inline std::pair<LocalArray<MeasureUnit>, int32_t> splitToSingleUnits(UErrorCode& status) const;

    /**
     * getAvailable gets all of the available units.
     * If there are too many units to fit into destCapacity then the
     * error code is set to U_BUFFER_OVERFLOW_ERROR.
     *
     * @param destArray destination buffer.
     * @param destCapacity number of MeasureUnit instances available at dest.
     * @param errorCode ICU error code.
     * @return number of available units.
     * @stable ICU 53
     */
    static int32_t getAvailable(
            MeasureUnit *destArray,
            int32_t destCapacity,
            UErrorCode &errorCode);

    /**
     * getAvailable gets all of the available units for a specific type.
     * If there are too many units to fit into destCapacity then the
     * error code is set to U_BUFFER_OVERFLOW_ERROR.
     *
     * @param type the type
     * @param destArray destination buffer.
     * @param destCapacity number of MeasureUnit instances available at dest.
     * @param errorCode ICU error code.
     * @return number of available units for type.
     * @stable ICU 53
     */
    static int32_t getAvailable(
            const char *type,
            MeasureUnit *destArray,
            int32_t destCapacity,
            UErrorCode &errorCode);

    /**
     * getAvailableTypes gets all of the available types. Caller owns the
     * returned StringEnumeration and must delete it when finished using it.
     *
     * @param errorCode ICU error code.
     * @return the types.
     * @stable ICU 53
     */
    static StringEnumeration* getAvailableTypes(UErrorCode &errorCode);

    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       Derived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 53
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID POLYMORPHICALLY. Pure virtual override. This
     * method is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI. Polymorphic operator==() and clone()
     * methods call this method.
     *
     * @return          The class ID for this object. All objects of a
     *                  given class have the same class ID.  Objects of
     *                  other classes have different class IDs.
     * @stable ICU 53
     */
    virtual UClassID getDynamicClassID() const override;

#ifndef U_HIDE_INTERNAL_API
    /**
     * ICU use only.
     * Returns associated array index for this measure unit.
     * @internal
     */
    int32_t getOffset() const;
#endif /* U_HIDE_INTERNAL_API */

// All code between the "Start generated createXXX methods" comment and
// the "End generated createXXX methods" comment is auto generated code
// and must not be edited manually. For instructions on how to correctly
// update this code, refer to:
// docs/processes/release/tasks/updating-measure-unit.md
//
// Start generated createXXX methods

    /**
     * Returns by pointer, unit of acceleration: g-force.
     * Caller owns returned value and must free it.
     * Also see {@link #getGForce()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createGForce(UErrorCode &status);

    /**
     * Returns by value, unit of acceleration: g-force.
     * Also see {@link #createGForce()}.
     * @stable ICU 64
     */
    static MeasureUnit getGForce();

    /**
     * Returns by pointer, unit of acceleration: meter-per-square-second.
     * Caller owns returned value and must free it.
     * Also see {@link #getMeterPerSecondSquared()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMeterPerSecondSquared(UErrorCode &status);

    /**
     * Returns by value, unit of acceleration: meter-per-square-second.
     * Also see {@link #createMeterPerSecondSquared()}.
     * @stable ICU 64
     */
    static MeasureUnit getMeterPerSecondSquared();

    /**
     * Returns by pointer, unit of angle: arc-minute.
     * Caller owns returned value and must free it.
     * Also see {@link #getArcMinute()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createArcMinute(UErrorCode &status);

    /**
     * Returns by value, unit of angle: arc-minute.
     * Also see {@link #createArcMinute()}.
     * @stable ICU 64
     */
    static MeasureUnit getArcMinute();

    /**
     * Returns by pointer, unit of angle: arc-second.
     * Caller owns returned value and must free it.
     * Also see {@link #getArcSecond()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createArcSecond(UErrorCode &status);

    /**
     * Returns by value, unit of angle: arc-second.
     * Also see {@link #createArcSecond()}.
     * @stable ICU 64
     */
    static MeasureUnit getArcSecond();

    /**
     * Returns by pointer, unit of angle: degree.
     * Caller owns returned value and must free it.
     * Also see {@link #getDegree()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createDegree(UErrorCode &status);

    /**
     * Returns by value, unit of angle: degree.
     * Also see {@link #createDegree()}.
     * @stable ICU 64
     */
    static MeasureUnit getDegree();

    /**
     * Returns by pointer, unit of angle: radian.
     * Caller owns returned value and must free it.
     * Also see {@link #getRadian()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createRadian(UErrorCode &status);

    /**
     * Returns by value, unit of angle: radian.
     * Also see {@link #createRadian()}.
     * @stable ICU 64
     */
    static MeasureUnit getRadian();

    /**
     * Returns by pointer, unit of angle: revolution.
     * Caller owns returned value and must free it.
     * Also see {@link #getRevolutionAngle()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createRevolutionAngle(UErrorCode &status);

    /**
     * Returns by value, unit of angle: revolution.
     * Also see {@link #createRevolutionAngle()}.
     * @stable ICU 64
     */
    static MeasureUnit getRevolutionAngle();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of angle: steradian.
     * Caller owns returned value and must free it.
     * Also see {@link #getSteradian()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createSteradian(UErrorCode &status);

    /**
     * Returns by value, unit of angle: steradian.
     * Also see {@link #createSteradian()}.
     * @draft ICU 78
     */
    static MeasureUnit getSteradian();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of area: acre.
     * Caller owns returned value and must free it.
     * Also see {@link #getAcre()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createAcre(UErrorCode &status);

    /**
     * Returns by value, unit of area: acre.
     * Also see {@link #createAcre()}.
     * @stable ICU 64
     */
    static MeasureUnit getAcre();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of area: bu-jp.
     * Caller owns returned value and must free it.
     * Also see {@link #getBuJp()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createBuJp(UErrorCode &status);

    /**
     * Returns by value, unit of area: bu-jp.
     * Also see {@link #createBuJp()}.
     * @draft ICU 78
     */
    static MeasureUnit getBuJp();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of area: cho.
     * Caller owns returned value and must free it.
     * Also see {@link #getCho()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createCho(UErrorCode &status);

    /**
     * Returns by value, unit of area: cho.
     * Also see {@link #createCho()}.
     * @draft ICU 78
     */
    static MeasureUnit getCho();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of area: dunam.
     * Caller owns returned value and must free it.
     * Also see {@link #getDunam()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createDunam(UErrorCode &status);

    /**
     * Returns by value, unit of area: dunam.
     * Also see {@link #createDunam()}.
     * @stable ICU 64
     */
    static MeasureUnit getDunam();

    /**
     * Returns by pointer, unit of area: hectare.
     * Caller owns returned value and must free it.
     * Also see {@link #getHectare()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createHectare(UErrorCode &status);

    /**
     * Returns by value, unit of area: hectare.
     * Also see {@link #createHectare()}.
     * @stable ICU 64
     */
    static MeasureUnit getHectare();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of area: se-jp.
     * Caller owns returned value and must free it.
     * Also see {@link #getSeJp()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createSeJp(UErrorCode &status);

    /**
     * Returns by value, unit of area: se-jp.
     * Also see {@link #createSeJp()}.
     * @draft ICU 78
     */
    static MeasureUnit getSeJp();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of area: square-centimeter.
     * Caller owns returned value and must free it.
     * Also see {@link #getSquareCentimeter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createSquareCentimeter(UErrorCode &status);

    /**
     * Returns by value, unit of area: square-centimeter.
     * Also see {@link #createSquareCentimeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getSquareCentimeter();

    /**
     * Returns by pointer, unit of area: square-foot.
     * Caller owns returned value and must free it.
     * Also see {@link #getSquareFoot()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createSquareFoot(UErrorCode &status);

    /**
     * Returns by value, unit of area: square-foot.
     * Also see {@link #createSquareFoot()}.
     * @stable ICU 64
     */
    static MeasureUnit getSquareFoot();

    /**
     * Returns by pointer, unit of area: square-inch.
     * Caller owns returned value and must free it.
     * Also see {@link #getSquareInch()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createSquareInch(UErrorCode &status);

    /**
     * Returns by value, unit of area: square-inch.
     * Also see {@link #createSquareInch()}.
     * @stable ICU 64
     */
    static MeasureUnit getSquareInch();

    /**
     * Returns by pointer, unit of area: square-kilometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getSquareKilometer()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createSquareKilometer(UErrorCode &status);

    /**
     * Returns by value, unit of area: square-kilometer.
     * Also see {@link #createSquareKilometer()}.
     * @stable ICU 64
     */
    static MeasureUnit getSquareKilometer();

    /**
     * Returns by pointer, unit of area: square-meter.
     * Caller owns returned value and must free it.
     * Also see {@link #getSquareMeter()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createSquareMeter(UErrorCode &status);

    /**
     * Returns by value, unit of area: square-meter.
     * Also see {@link #createSquareMeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getSquareMeter();

    /**
     * Returns by pointer, unit of area: square-mile.
     * Caller owns returned value and must free it.
     * Also see {@link #getSquareMile()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createSquareMile(UErrorCode &status);

    /**
     * Returns by value, unit of area: square-mile.
     * Also see {@link #createSquareMile()}.
     * @stable ICU 64
     */
    static MeasureUnit getSquareMile();

    /**
     * Returns by pointer, unit of area: square-yard.
     * Caller owns returned value and must free it.
     * Also see {@link #getSquareYard()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createSquareYard(UErrorCode &status);

    /**
     * Returns by value, unit of area: square-yard.
     * Also see {@link #createSquareYard()}.
     * @stable ICU 64
     */
    static MeasureUnit getSquareYard();

    /**
     * Returns by pointer, unit of concentr: item.
     * Caller owns returned value and must free it.
     * Also see {@link #getItem()}.
     * @param status ICU error code.
     * @stable ICU 70
     */
    static MeasureUnit *createItem(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: item.
     * Also see {@link #createItem()}.
     * @stable ICU 70
     */
    static MeasureUnit getItem();

    /**
     * Returns by pointer, unit of concentr: karat.
     * Caller owns returned value and must free it.
     * Also see {@link #getKarat()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKarat(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: karat.
     * Also see {@link #createKarat()}.
     * @stable ICU 64
     */
    static MeasureUnit getKarat();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of concentr: katal.
     * Caller owns returned value and must free it.
     * Also see {@link #getKatal()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createKatal(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: katal.
     * Also see {@link #createKatal()}.
     * @draft ICU 78
     */
    static MeasureUnit getKatal();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of concentr: milligram-ofglucose-per-deciliter.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilligramOfglucosePerDeciliter()}.
     * @param status ICU error code.
     * @stable ICU 69
     */
    static MeasureUnit *createMilligramOfglucosePerDeciliter(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: milligram-ofglucose-per-deciliter.
     * Also see {@link #createMilligramOfglucosePerDeciliter()}.
     * @stable ICU 69
     */
    static MeasureUnit getMilligramOfglucosePerDeciliter();

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Returns by pointer, unit of concentr: milligram-per-deciliter.
     * (renamed to milligram-ofglucose-per-deciliter in CLDR 39 / ICU 69).
     * Caller owns returned value and must free it.
     * Also see {@link #createMilligramOfglucosePerDeciliter()}.
     * Also see {@link #getMilligramPerDeciliter()}.
     * @param status ICU error code.
     * @deprecated ICU 78 use createMilligramOfglucosePerDeciliter(UErrorCode &status)
     */
    static MeasureUnit *createMilligramPerDeciliter(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: milligram-per-deciliter.
     * (renamed to milligram-ofglucose-per-deciliter in CLDR 39 / ICU 69).
     * Also see {@link #getMilligramOfglucosePerDeciliter()}.
     * Also see {@link #createMilligramPerDeciliter()}.
     * @deprecated ICU 78 use getMilligramOfglucosePerDeciliter()
     */
    static MeasureUnit getMilligramPerDeciliter();
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Returns by pointer, unit of concentr: millimole-per-liter.
     * Caller owns returned value and must free it.
     * Also see {@link #getMillimolePerLiter()}.
     * @param status ICU error code.
     * @stable ICU 57
     */
    static MeasureUnit *createMillimolePerLiter(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: millimole-per-liter.
     * Also see {@link #createMillimolePerLiter()}.
     * @stable ICU 64
     */
    static MeasureUnit getMillimolePerLiter();

    /**
     * Returns by pointer, unit of concentr: mole.
     * Caller owns returned value and must free it.
     * Also see {@link #getMole()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createMole(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: mole.
     * Also see {@link #createMole()}.
     * @stable ICU 64
     */
    static MeasureUnit getMole();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of concentr: ofglucose.
     * Caller owns returned value and must free it.
     * Also see {@link #getOfglucose()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createOfglucose(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: ofglucose.
     * Also see {@link #createOfglucose()}.
     * @draft ICU 78
     */
    static MeasureUnit getOfglucose();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of concentr: part.
     * Caller owns returned value and must free it.
     * Also see {@link #getPart()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createPart(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: part.
     * Also see {@link #createPart()}.
     * @draft ICU 78
     */
    static MeasureUnit getPart();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of concentr: part-per-1e6.
     * Caller owns returned value and must free it.
     * Also see {@link #getPartPer1E6()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createPartPer1E6(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: part-per-1e6.
     * Also see {@link #createPartPer1E6()}.
     * @draft ICU 78
     */
    static MeasureUnit getPartPer1E6();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of concentr: part-per-million.
     * (renamed to part-per-1e6 in CLDR 48 / ICU 78).
     * Caller owns returned value and must free it.
     * Also see {@link #createPartPer1E6()}.
     * Also see {@link #getPartPerMillion()}.
     * @param status ICU error code.
     * @stable ICU 57
     */
    static MeasureUnit *createPartPerMillion(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: part-per-million.
     * (renamed to part-per-1e6 in CLDR 48 / ICU 78).
     * Also see {@link #getPartPer1E6()}.
     * Also see {@link #createPartPerMillion()}.
     * @stable ICU 64
     */
    static MeasureUnit getPartPerMillion();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of concentr: part-per-1e9.
     * Caller owns returned value and must free it.
     * Also see {@link #getPartPer1E9()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createPartPer1E9(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: part-per-1e9.
     * Also see {@link #createPartPer1E9()}.
     * @draft ICU 78
     */
    static MeasureUnit getPartPer1E9();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of concentr: percent.
     * Caller owns returned value and must free it.
     * Also see {@link #getPercent()}.
     * @param status ICU error code.
     * @stable ICU 63
     */
    static MeasureUnit *createPercent(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: percent.
     * Also see {@link #createPercent()}.
     * @stable ICU 64
     */
    static MeasureUnit getPercent();

    /**
     * Returns by pointer, unit of concentr: permille.
     * Caller owns returned value and must free it.
     * Also see {@link #getPermille()}.
     * @param status ICU error code.
     * @stable ICU 63
     */
    static MeasureUnit *createPermille(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: permille.
     * Also see {@link #createPermille()}.
     * @stable ICU 64
     */
    static MeasureUnit getPermille();

    /**
     * Returns by pointer, unit of concentr: permyriad.
     * Caller owns returned value and must free it.
     * Also see {@link #getPermyriad()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createPermyriad(UErrorCode &status);

    /**
     * Returns by value, unit of concentr: permyriad.
     * Also see {@link #createPermyriad()}.
     * @stable ICU 64
     */
    static MeasureUnit getPermyriad();

    /**
     * Returns by pointer, unit of consumption: liter-per-100-kilometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getLiterPer100Kilometers()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createLiterPer100Kilometers(UErrorCode &status);

    /**
     * Returns by value, unit of consumption: liter-per-100-kilometer.
     * Also see {@link #createLiterPer100Kilometers()}.
     * @stable ICU 64
     */
    static MeasureUnit getLiterPer100Kilometers();

    /**
     * Returns by pointer, unit of consumption: liter-per-kilometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getLiterPerKilometer()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createLiterPerKilometer(UErrorCode &status);

    /**
     * Returns by value, unit of consumption: liter-per-kilometer.
     * Also see {@link #createLiterPerKilometer()}.
     * @stable ICU 64
     */
    static MeasureUnit getLiterPerKilometer();

    /**
     * Returns by pointer, unit of consumption: mile-per-gallon.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilePerGallon()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMilePerGallon(UErrorCode &status);

    /**
     * Returns by value, unit of consumption: mile-per-gallon.
     * Also see {@link #createMilePerGallon()}.
     * @stable ICU 64
     */
    static MeasureUnit getMilePerGallon();

    /**
     * Returns by pointer, unit of consumption: mile-per-gallon-imperial.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilePerGallonImperial()}.
     * @param status ICU error code.
     * @stable ICU 57
     */
    static MeasureUnit *createMilePerGallonImperial(UErrorCode &status);

    /**
     * Returns by value, unit of consumption: mile-per-gallon-imperial.
     * Also see {@link #createMilePerGallonImperial()}.
     * @stable ICU 64
     */
    static MeasureUnit getMilePerGallonImperial();

    /**
     * Returns by pointer, unit of digital: bit.
     * Caller owns returned value and must free it.
     * Also see {@link #getBit()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createBit(UErrorCode &status);

    /**
     * Returns by value, unit of digital: bit.
     * Also see {@link #createBit()}.
     * @stable ICU 64
     */
    static MeasureUnit getBit();

    /**
     * Returns by pointer, unit of digital: byte.
     * Caller owns returned value and must free it.
     * Also see {@link #getByte()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createByte(UErrorCode &status);

    /**
     * Returns by value, unit of digital: byte.
     * Also see {@link #createByte()}.
     * @stable ICU 64
     */
    static MeasureUnit getByte();

    /**
     * Returns by pointer, unit of digital: gigabit.
     * Caller owns returned value and must free it.
     * Also see {@link #getGigabit()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createGigabit(UErrorCode &status);

    /**
     * Returns by value, unit of digital: gigabit.
     * Also see {@link #createGigabit()}.
     * @stable ICU 64
     */
    static MeasureUnit getGigabit();

    /**
     * Returns by pointer, unit of digital: gigabyte.
     * Caller owns returned value and must free it.
     * Also see {@link #getGigabyte()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createGigabyte(UErrorCode &status);

    /**
     * Returns by value, unit of digital: gigabyte.
     * Also see {@link #createGigabyte()}.
     * @stable ICU 64
     */
    static MeasureUnit getGigabyte();

    /**
     * Returns by pointer, unit of digital: kilobit.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilobit()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKilobit(UErrorCode &status);

    /**
     * Returns by value, unit of digital: kilobit.
     * Also see {@link #createKilobit()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilobit();

    /**
     * Returns by pointer, unit of digital: kilobyte.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilobyte()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKilobyte(UErrorCode &status);

    /**
     * Returns by value, unit of digital: kilobyte.
     * Also see {@link #createKilobyte()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilobyte();

    /**
     * Returns by pointer, unit of digital: megabit.
     * Caller owns returned value and must free it.
     * Also see {@link #getMegabit()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMegabit(UErrorCode &status);

    /**
     * Returns by value, unit of digital: megabit.
     * Also see {@link #createMegabit()}.
     * @stable ICU 64
     */
    static MeasureUnit getMegabit();

    /**
     * Returns by pointer, unit of digital: megabyte.
     * Caller owns returned value and must free it.
     * Also see {@link #getMegabyte()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMegabyte(UErrorCode &status);

    /**
     * Returns by value, unit of digital: megabyte.
     * Also see {@link #createMegabyte()}.
     * @stable ICU 64
     */
    static MeasureUnit getMegabyte();

    /**
     * Returns by pointer, unit of digital: petabyte.
     * Caller owns returned value and must free it.
     * Also see {@link #getPetabyte()}.
     * @param status ICU error code.
     * @stable ICU 63
     */
    static MeasureUnit *createPetabyte(UErrorCode &status);

    /**
     * Returns by value, unit of digital: petabyte.
     * Also see {@link #createPetabyte()}.
     * @stable ICU 64
     */
    static MeasureUnit getPetabyte();

    /**
     * Returns by pointer, unit of digital: terabit.
     * Caller owns returned value and must free it.
     * Also see {@link #getTerabit()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createTerabit(UErrorCode &status);

    /**
     * Returns by value, unit of digital: terabit.
     * Also see {@link #createTerabit()}.
     * @stable ICU 64
     */
    static MeasureUnit getTerabit();

    /**
     * Returns by pointer, unit of digital: terabyte.
     * Caller owns returned value and must free it.
     * Also see {@link #getTerabyte()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createTerabyte(UErrorCode &status);

    /**
     * Returns by value, unit of digital: terabyte.
     * Also see {@link #createTerabyte()}.
     * @stable ICU 64
     */
    static MeasureUnit getTerabyte();

    /**
     * Returns by pointer, unit of duration: century.
     * Caller owns returned value and must free it.
     * Also see {@link #getCentury()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createCentury(UErrorCode &status);

    /**
     * Returns by value, unit of duration: century.
     * Also see {@link #createCentury()}.
     * @stable ICU 64
     */
    static MeasureUnit getCentury();

    /**
     * Returns by pointer, unit of duration: day.
     * Caller owns returned value and must free it.
     * Also see {@link #getDay()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createDay(UErrorCode &status);

    /**
     * Returns by value, unit of duration: day.
     * Also see {@link #createDay()}.
     * @stable ICU 64
     */
    static MeasureUnit getDay();

    /**
     * Returns by pointer, unit of duration: day-person.
     * Caller owns returned value and must free it.
     * Also see {@link #getDayPerson()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createDayPerson(UErrorCode &status);

    /**
     * Returns by value, unit of duration: day-person.
     * Also see {@link #createDayPerson()}.
     * @stable ICU 64
     */
    static MeasureUnit getDayPerson();

    /**
     * Returns by pointer, unit of duration: decade.
     * Caller owns returned value and must free it.
     * Also see {@link #getDecade()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createDecade(UErrorCode &status);

    /**
     * Returns by value, unit of duration: decade.
     * Also see {@link #createDecade()}.
     * @stable ICU 65
     */
    static MeasureUnit getDecade();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of duration: fortnight.
     * Caller owns returned value and must free it.
     * Also see {@link #getFortnight()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createFortnight(UErrorCode &status);

    /**
     * Returns by value, unit of duration: fortnight.
     * Also see {@link #createFortnight()}.
     * @draft ICU 78
     */
    static MeasureUnit getFortnight();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of duration: hour.
     * Caller owns returned value and must free it.
     * Also see {@link #getHour()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createHour(UErrorCode &status);

    /**
     * Returns by value, unit of duration: hour.
     * Also see {@link #createHour()}.
     * @stable ICU 64
     */
    static MeasureUnit getHour();

    /**
     * Returns by pointer, unit of duration: microsecond.
     * Caller owns returned value and must free it.
     * Also see {@link #getMicrosecond()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMicrosecond(UErrorCode &status);

    /**
     * Returns by value, unit of duration: microsecond.
     * Also see {@link #createMicrosecond()}.
     * @stable ICU 64
     */
    static MeasureUnit getMicrosecond();

    /**
     * Returns by pointer, unit of duration: millisecond.
     * Caller owns returned value and must free it.
     * Also see {@link #getMillisecond()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMillisecond(UErrorCode &status);

    /**
     * Returns by value, unit of duration: millisecond.
     * Also see {@link #createMillisecond()}.
     * @stable ICU 64
     */
    static MeasureUnit getMillisecond();

    /**
     * Returns by pointer, unit of duration: minute.
     * Caller owns returned value and must free it.
     * Also see {@link #getMinute()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMinute(UErrorCode &status);

    /**
     * Returns by value, unit of duration: minute.
     * Also see {@link #createMinute()}.
     * @stable ICU 64
     */
    static MeasureUnit getMinute();

    /**
     * Returns by pointer, unit of duration: month.
     * Caller owns returned value and must free it.
     * Also see {@link #getMonth()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMonth(UErrorCode &status);

    /**
     * Returns by value, unit of duration: month.
     * Also see {@link #createMonth()}.
     * @stable ICU 64
     */
    static MeasureUnit getMonth();

    /**
     * Returns by pointer, unit of duration: month-person.
     * Caller owns returned value and must free it.
     * Also see {@link #getMonthPerson()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createMonthPerson(UErrorCode &status);

    /**
     * Returns by value, unit of duration: month-person.
     * Also see {@link #createMonthPerson()}.
     * @stable ICU 64
     */
    static MeasureUnit getMonthPerson();

    /**
     * Returns by pointer, unit of duration: nanosecond.
     * Caller owns returned value and must free it.
     * Also see {@link #getNanosecond()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createNanosecond(UErrorCode &status);

    /**
     * Returns by value, unit of duration: nanosecond.
     * Also see {@link #createNanosecond()}.
     * @stable ICU 64
     */
    static MeasureUnit getNanosecond();

    /**
     * Returns by pointer, unit of duration: night.
     * Caller owns returned value and must free it.
     * Also see {@link #getNight()}.
     * @param status ICU error code.
     * @stable ICU 76
     */
    static MeasureUnit *createNight(UErrorCode &status);

    /**
     * Returns by value, unit of duration: night.
     * Also see {@link #createNight()}.
     * @stable ICU 76
     */
    static MeasureUnit getNight();

    /**
     * Returns by pointer, unit of duration: quarter.
     * Caller owns returned value and must free it.
     * Also see {@link #getQuarter()}.
     * @param status ICU error code.
     * @stable ICU 72
     */
    static MeasureUnit *createQuarter(UErrorCode &status);

    /**
     * Returns by value, unit of duration: quarter.
     * Also see {@link #createQuarter()}.
     * @stable ICU 72
     */
    static MeasureUnit getQuarter();

    /**
     * Returns by pointer, unit of duration: second.
     * Caller owns returned value and must free it.
     * Also see {@link #getSecond()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createSecond(UErrorCode &status);

    /**
     * Returns by value, unit of duration: second.
     * Also see {@link #createSecond()}.
     * @stable ICU 64
     */
    static MeasureUnit getSecond();

    /**
     * Returns by pointer, unit of duration: week.
     * Caller owns returned value and must free it.
     * Also see {@link #getWeek()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createWeek(UErrorCode &status);

    /**
     * Returns by value, unit of duration: week.
     * Also see {@link #createWeek()}.
     * @stable ICU 64
     */
    static MeasureUnit getWeek();

    /**
     * Returns by pointer, unit of duration: week-person.
     * Caller owns returned value and must free it.
     * Also see {@link #getWeekPerson()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createWeekPerson(UErrorCode &status);

    /**
     * Returns by value, unit of duration: week-person.
     * Also see {@link #createWeekPerson()}.
     * @stable ICU 64
     */
    static MeasureUnit getWeekPerson();

    /**
     * Returns by pointer, unit of duration: year.
     * Caller owns returned value and must free it.
     * Also see {@link #getYear()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createYear(UErrorCode &status);

    /**
     * Returns by value, unit of duration: year.
     * Also see {@link #createYear()}.
     * @stable ICU 64
     */
    static MeasureUnit getYear();

    /**
     * Returns by pointer, unit of duration: year-person.
     * Caller owns returned value and must free it.
     * Also see {@link #getYearPerson()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createYearPerson(UErrorCode &status);

    /**
     * Returns by value, unit of duration: year-person.
     * Also see {@link #createYearPerson()}.
     * @stable ICU 64
     */
    static MeasureUnit getYearPerson();

    /**
     * Returns by pointer, unit of electric: ampere.
     * Caller owns returned value and must free it.
     * Also see {@link #getAmpere()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createAmpere(UErrorCode &status);

    /**
     * Returns by value, unit of electric: ampere.
     * Also see {@link #createAmpere()}.
     * @stable ICU 64
     */
    static MeasureUnit getAmpere();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of electric: coulomb.
     * Caller owns returned value and must free it.
     * Also see {@link #getCoulomb()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createCoulomb(UErrorCode &status);

    /**
     * Returns by value, unit of electric: coulomb.
     * Also see {@link #createCoulomb()}.
     * @draft ICU 78
     */
    static MeasureUnit getCoulomb();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of electric: farad.
     * Caller owns returned value and must free it.
     * Also see {@link #getFarad()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createFarad(UErrorCode &status);

    /**
     * Returns by value, unit of electric: farad.
     * Also see {@link #createFarad()}.
     * @draft ICU 78
     */
    static MeasureUnit getFarad();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of electric: henry.
     * Caller owns returned value and must free it.
     * Also see {@link #getHenry()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createHenry(UErrorCode &status);

    /**
     * Returns by value, unit of electric: henry.
     * Also see {@link #createHenry()}.
     * @draft ICU 78
     */
    static MeasureUnit getHenry();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of electric: milliampere.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilliampere()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMilliampere(UErrorCode &status);

    /**
     * Returns by value, unit of electric: milliampere.
     * Also see {@link #createMilliampere()}.
     * @stable ICU 64
     */
    static MeasureUnit getMilliampere();

    /**
     * Returns by pointer, unit of electric: ohm.
     * Caller owns returned value and must free it.
     * Also see {@link #getOhm()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createOhm(UErrorCode &status);

    /**
     * Returns by value, unit of electric: ohm.
     * Also see {@link #createOhm()}.
     * @stable ICU 64
     */
    static MeasureUnit getOhm();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of electric: siemens.
     * Caller owns returned value and must free it.
     * Also see {@link #getSiemens()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createSiemens(UErrorCode &status);

    /**
     * Returns by value, unit of electric: siemens.
     * Also see {@link #createSiemens()}.
     * @draft ICU 78
     */
    static MeasureUnit getSiemens();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of electric: volt.
     * Caller owns returned value and must free it.
     * Also see {@link #getVolt()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createVolt(UErrorCode &status);

    /**
     * Returns by value, unit of electric: volt.
     * Also see {@link #createVolt()}.
     * @stable ICU 64
     */
    static MeasureUnit getVolt();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of energy: becquerel.
     * Caller owns returned value and must free it.
     * Also see {@link #getBecquerel()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createBecquerel(UErrorCode &status);

    /**
     * Returns by value, unit of energy: becquerel.
     * Also see {@link #createBecquerel()}.
     * @draft ICU 78
     */
    static MeasureUnit getBecquerel();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of energy: british-thermal-unit.
     * Caller owns returned value and must free it.
     * Also see {@link #getBritishThermalUnit()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createBritishThermalUnit(UErrorCode &status);

    /**
     * Returns by value, unit of energy: british-thermal-unit.
     * Also see {@link #createBritishThermalUnit()}.
     * @stable ICU 64
     */
    static MeasureUnit getBritishThermalUnit();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of energy: british-thermal-unit-it.
     * Caller owns returned value and must free it.
     * Also see {@link #getBritishThermalUnitIt()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createBritishThermalUnitIt(UErrorCode &status);

    /**
     * Returns by value, unit of energy: british-thermal-unit-it.
     * Also see {@link #createBritishThermalUnitIt()}.
     * @draft ICU 78
     */
    static MeasureUnit getBritishThermalUnitIt();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of energy: calorie.
     * Caller owns returned value and must free it.
     * Also see {@link #getCalorie()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCalorie(UErrorCode &status);

    /**
     * Returns by value, unit of energy: calorie.
     * Also see {@link #createCalorie()}.
     * @stable ICU 64
     */
    static MeasureUnit getCalorie();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of energy: calorie-it.
     * Caller owns returned value and must free it.
     * Also see {@link #getCalorieIt()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createCalorieIt(UErrorCode &status);

    /**
     * Returns by value, unit of energy: calorie-it.
     * Also see {@link #createCalorieIt()}.
     * @draft ICU 78
     */
    static MeasureUnit getCalorieIt();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of energy: electronvolt.
     * Caller owns returned value and must free it.
     * Also see {@link #getElectronvolt()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createElectronvolt(UErrorCode &status);

    /**
     * Returns by value, unit of energy: electronvolt.
     * Also see {@link #createElectronvolt()}.
     * @stable ICU 64
     */
    static MeasureUnit getElectronvolt();

    /**
     * Returns by pointer, unit of energy: foodcalorie.
     * Caller owns returned value and must free it.
     * Also see {@link #getFoodcalorie()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createFoodcalorie(UErrorCode &status);

    /**
     * Returns by value, unit of energy: foodcalorie.
     * Also see {@link #createFoodcalorie()}.
     * @stable ICU 64
     */
    static MeasureUnit getFoodcalorie();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of energy: gray.
     * Caller owns returned value and must free it.
     * Also see {@link #getGray()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createGray(UErrorCode &status);

    /**
     * Returns by value, unit of energy: gray.
     * Also see {@link #createGray()}.
     * @draft ICU 78
     */
    static MeasureUnit getGray();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of energy: joule.
     * Caller owns returned value and must free it.
     * Also see {@link #getJoule()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createJoule(UErrorCode &status);

    /**
     * Returns by value, unit of energy: joule.
     * Also see {@link #createJoule()}.
     * @stable ICU 64
     */
    static MeasureUnit getJoule();

    /**
     * Returns by pointer, unit of energy: kilocalorie.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilocalorie()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKilocalorie(UErrorCode &status);

    /**
     * Returns by value, unit of energy: kilocalorie.
     * Also see {@link #createKilocalorie()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilocalorie();

    /**
     * Returns by pointer, unit of energy: kilojoule.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilojoule()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKilojoule(UErrorCode &status);

    /**
     * Returns by value, unit of energy: kilojoule.
     * Also see {@link #createKilojoule()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilojoule();

    /**
     * Returns by pointer, unit of energy: kilowatt-hour.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilowattHour()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKilowattHour(UErrorCode &status);

    /**
     * Returns by value, unit of energy: kilowatt-hour.
     * Also see {@link #createKilowattHour()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilowattHour();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of energy: sievert.
     * Caller owns returned value and must free it.
     * Also see {@link #getSievert()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createSievert(UErrorCode &status);

    /**
     * Returns by value, unit of energy: sievert.
     * Also see {@link #createSievert()}.
     * @draft ICU 78
     */
    static MeasureUnit getSievert();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of energy: therm-us.
     * Caller owns returned value and must free it.
     * Also see {@link #getThermUs()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createThermUs(UErrorCode &status);

    /**
     * Returns by value, unit of energy: therm-us.
     * Also see {@link #createThermUs()}.
     * @stable ICU 65
     */
    static MeasureUnit getThermUs();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of force: kilogram-force.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilogramForce()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createKilogramForce(UErrorCode &status);

    /**
     * Returns by value, unit of force: kilogram-force.
     * Also see {@link #createKilogramForce()}.
     * @draft ICU 78
     */
    static MeasureUnit getKilogramForce();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of force: kilowatt-hour-per-100-kilometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilowattHourPer100Kilometer()}.
     * @param status ICU error code.
     * @stable ICU 70
     */
    static MeasureUnit *createKilowattHourPer100Kilometer(UErrorCode &status);

    /**
     * Returns by value, unit of force: kilowatt-hour-per-100-kilometer.
     * Also see {@link #createKilowattHourPer100Kilometer()}.
     * @stable ICU 70
     */
    static MeasureUnit getKilowattHourPer100Kilometer();

    /**
     * Returns by pointer, unit of force: newton.
     * Caller owns returned value and must free it.
     * Also see {@link #getNewton()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createNewton(UErrorCode &status);

    /**
     * Returns by value, unit of force: newton.
     * Also see {@link #createNewton()}.
     * @stable ICU 64
     */
    static MeasureUnit getNewton();

    /**
     * Returns by pointer, unit of force: pound-force.
     * Caller owns returned value and must free it.
     * Also see {@link #getPoundForce()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createPoundForce(UErrorCode &status);

    /**
     * Returns by value, unit of force: pound-force.
     * Also see {@link #createPoundForce()}.
     * @stable ICU 64
     */
    static MeasureUnit getPoundForce();

    /**
     * Returns by pointer, unit of frequency: gigahertz.
     * Caller owns returned value and must free it.
     * Also see {@link #getGigahertz()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createGigahertz(UErrorCode &status);

    /**
     * Returns by value, unit of frequency: gigahertz.
     * Also see {@link #createGigahertz()}.
     * @stable ICU 64
     */
    static MeasureUnit getGigahertz();

    /**
     * Returns by pointer, unit of frequency: hertz.
     * Caller owns returned value and must free it.
     * Also see {@link #getHertz()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createHertz(UErrorCode &status);

    /**
     * Returns by value, unit of frequency: hertz.
     * Also see {@link #createHertz()}.
     * @stable ICU 64
     */
    static MeasureUnit getHertz();

    /**
     * Returns by pointer, unit of frequency: kilohertz.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilohertz()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKilohertz(UErrorCode &status);

    /**
     * Returns by value, unit of frequency: kilohertz.
     * Also see {@link #createKilohertz()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilohertz();

    /**
     * Returns by pointer, unit of frequency: megahertz.
     * Caller owns returned value and must free it.
     * Also see {@link #getMegahertz()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMegahertz(UErrorCode &status);

    /**
     * Returns by value, unit of frequency: megahertz.
     * Also see {@link #createMegahertz()}.
     * @stable ICU 64
     */
    static MeasureUnit getMegahertz();

    /**
     * Returns by pointer, unit of graphics: dot.
     * Caller owns returned value and must free it.
     * Also see {@link #getDot()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createDot(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: dot.
     * Also see {@link #createDot()}.
     * @stable ICU 68
     */
    static MeasureUnit getDot();

    /**
     * Returns by pointer, unit of graphics: dot-per-centimeter.
     * Caller owns returned value and must free it.
     * Also see {@link #getDotPerCentimeter()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createDotPerCentimeter(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: dot-per-centimeter.
     * Also see {@link #createDotPerCentimeter()}.
     * @stable ICU 65
     */
    static MeasureUnit getDotPerCentimeter();

    /**
     * Returns by pointer, unit of graphics: dot-per-inch.
     * Caller owns returned value and must free it.
     * Also see {@link #getDotPerInch()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createDotPerInch(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: dot-per-inch.
     * Also see {@link #createDotPerInch()}.
     * @stable ICU 65
     */
    static MeasureUnit getDotPerInch();

    /**
     * Returns by pointer, unit of graphics: em.
     * Caller owns returned value and must free it.
     * Also see {@link #getEm()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createEm(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: em.
     * Also see {@link #createEm()}.
     * @stable ICU 65
     */
    static MeasureUnit getEm();

    /**
     * Returns by pointer, unit of graphics: megapixel.
     * Caller owns returned value and must free it.
     * Also see {@link #getMegapixel()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createMegapixel(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: megapixel.
     * Also see {@link #createMegapixel()}.
     * @stable ICU 65
     */
    static MeasureUnit getMegapixel();

    /**
     * Returns by pointer, unit of graphics: pixel.
     * Caller owns returned value and must free it.
     * Also see {@link #getPixel()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createPixel(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: pixel.
     * Also see {@link #createPixel()}.
     * @stable ICU 65
     */
    static MeasureUnit getPixel();

    /**
     * Returns by pointer, unit of graphics: pixel-per-centimeter.
     * Caller owns returned value and must free it.
     * Also see {@link #getPixelPerCentimeter()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createPixelPerCentimeter(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: pixel-per-centimeter.
     * Also see {@link #createPixelPerCentimeter()}.
     * @stable ICU 65
     */
    static MeasureUnit getPixelPerCentimeter();

    /**
     * Returns by pointer, unit of graphics: pixel-per-inch.
     * Caller owns returned value and must free it.
     * Also see {@link #getPixelPerInch()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createPixelPerInch(UErrorCode &status);

    /**
     * Returns by value, unit of graphics: pixel-per-inch.
     * Also see {@link #createPixelPerInch()}.
     * @stable ICU 65
     */
    static MeasureUnit getPixelPerInch();

    /**
     * Returns by pointer, unit of length: astronomical-unit.
     * Caller owns returned value and must free it.
     * Also see {@link #getAstronomicalUnit()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createAstronomicalUnit(UErrorCode &status);

    /**
     * Returns by value, unit of length: astronomical-unit.
     * Also see {@link #createAstronomicalUnit()}.
     * @stable ICU 64
     */
    static MeasureUnit getAstronomicalUnit();

    /**
     * Returns by pointer, unit of length: centimeter.
     * Caller owns returned value and must free it.
     * Also see {@link #getCentimeter()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createCentimeter(UErrorCode &status);

    /**
     * Returns by value, unit of length: centimeter.
     * Also see {@link #createCentimeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getCentimeter();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: chain.
     * Caller owns returned value and must free it.
     * Also see {@link #getChain()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createChain(UErrorCode &status);

    /**
     * Returns by value, unit of length: chain.
     * Also see {@link #createChain()}.
     * @draft ICU 78
     */
    static MeasureUnit getChain();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of length: decimeter.
     * Caller owns returned value and must free it.
     * Also see {@link #getDecimeter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createDecimeter(UErrorCode &status);

    /**
     * Returns by value, unit of length: decimeter.
     * Also see {@link #createDecimeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getDecimeter();

    /**
     * Returns by pointer, unit of length: earth-radius.
     * Caller owns returned value and must free it.
     * Also see {@link #getEarthRadius()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createEarthRadius(UErrorCode &status);

    /**
     * Returns by value, unit of length: earth-radius.
     * Also see {@link #createEarthRadius()}.
     * @stable ICU 68
     */
    static MeasureUnit getEarthRadius();

    /**
     * Returns by pointer, unit of length: fathom.
     * Caller owns returned value and must free it.
     * Also see {@link #getFathom()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createFathom(UErrorCode &status);

    /**
     * Returns by value, unit of length: fathom.
     * Also see {@link #createFathom()}.
     * @stable ICU 64
     */
    static MeasureUnit getFathom();

    /**
     * Returns by pointer, unit of length: foot.
     * Caller owns returned value and must free it.
     * Also see {@link #getFoot()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createFoot(UErrorCode &status);

    /**
     * Returns by value, unit of length: foot.
     * Also see {@link #createFoot()}.
     * @stable ICU 64
     */
    static MeasureUnit getFoot();

    /**
     * Returns by pointer, unit of length: furlong.
     * Caller owns returned value and must free it.
     * Also see {@link #getFurlong()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createFurlong(UErrorCode &status);

    /**
     * Returns by value, unit of length: furlong.
     * Also see {@link #createFurlong()}.
     * @stable ICU 64
     */
    static MeasureUnit getFurlong();

    /**
     * Returns by pointer, unit of length: inch.
     * Caller owns returned value and must free it.
     * Also see {@link #getInch()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createInch(UErrorCode &status);

    /**
     * Returns by value, unit of length: inch.
     * Also see {@link #createInch()}.
     * @stable ICU 64
     */
    static MeasureUnit getInch();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: jo-jp.
     * Caller owns returned value and must free it.
     * Also see {@link #getJoJp()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createJoJp(UErrorCode &status);

    /**
     * Returns by value, unit of length: jo-jp.
     * Also see {@link #createJoJp()}.
     * @draft ICU 78
     */
    static MeasureUnit getJoJp();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: ken.
     * Caller owns returned value and must free it.
     * Also see {@link #getKen()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createKen(UErrorCode &status);

    /**
     * Returns by value, unit of length: ken.
     * Also see {@link #createKen()}.
     * @draft ICU 78
     */
    static MeasureUnit getKen();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of length: kilometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilometer()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createKilometer(UErrorCode &status);

    /**
     * Returns by value, unit of length: kilometer.
     * Also see {@link #createKilometer()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilometer();

    /**
     * Returns by pointer, unit of length: light-year.
     * Caller owns returned value and must free it.
     * Also see {@link #getLightYear()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createLightYear(UErrorCode &status);

    /**
     * Returns by value, unit of length: light-year.
     * Also see {@link #createLightYear()}.
     * @stable ICU 64
     */
    static MeasureUnit getLightYear();

    /**
     * Returns by pointer, unit of length: meter.
     * Caller owns returned value and must free it.
     * Also see {@link #getMeter()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMeter(UErrorCode &status);

    /**
     * Returns by value, unit of length: meter.
     * Also see {@link #createMeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getMeter();

    /**
     * Returns by pointer, unit of length: micrometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getMicrometer()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMicrometer(UErrorCode &status);

    /**
     * Returns by value, unit of length: micrometer.
     * Also see {@link #createMicrometer()}.
     * @stable ICU 64
     */
    static MeasureUnit getMicrometer();

    /**
     * Returns by pointer, unit of length: mile.
     * Caller owns returned value and must free it.
     * Also see {@link #getMile()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMile(UErrorCode &status);

    /**
     * Returns by value, unit of length: mile.
     * Also see {@link #createMile()}.
     * @stable ICU 64
     */
    static MeasureUnit getMile();

    /**
     * Returns by pointer, unit of length: mile-scandinavian.
     * Caller owns returned value and must free it.
     * Also see {@link #getMileScandinavian()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createMileScandinavian(UErrorCode &status);

    /**
     * Returns by value, unit of length: mile-scandinavian.
     * Also see {@link #createMileScandinavian()}.
     * @stable ICU 64
     */
    static MeasureUnit getMileScandinavian();

    /**
     * Returns by pointer, unit of length: millimeter.
     * Caller owns returned value and must free it.
     * Also see {@link #getMillimeter()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMillimeter(UErrorCode &status);

    /**
     * Returns by value, unit of length: millimeter.
     * Also see {@link #createMillimeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getMillimeter();

    /**
     * Returns by pointer, unit of length: nanometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getNanometer()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createNanometer(UErrorCode &status);

    /**
     * Returns by value, unit of length: nanometer.
     * Also see {@link #createNanometer()}.
     * @stable ICU 64
     */
    static MeasureUnit getNanometer();

    /**
     * Returns by pointer, unit of length: nautical-mile.
     * Caller owns returned value and must free it.
     * Also see {@link #getNauticalMile()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createNauticalMile(UErrorCode &status);

    /**
     * Returns by value, unit of length: nautical-mile.
     * Also see {@link #createNauticalMile()}.
     * @stable ICU 64
     */
    static MeasureUnit getNauticalMile();

    /**
     * Returns by pointer, unit of length: parsec.
     * Caller owns returned value and must free it.
     * Also see {@link #getParsec()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createParsec(UErrorCode &status);

    /**
     * Returns by value, unit of length: parsec.
     * Also see {@link #createParsec()}.
     * @stable ICU 64
     */
    static MeasureUnit getParsec();

    /**
     * Returns by pointer, unit of length: picometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getPicometer()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createPicometer(UErrorCode &status);

    /**
     * Returns by value, unit of length: picometer.
     * Also see {@link #createPicometer()}.
     * @stable ICU 64
     */
    static MeasureUnit getPicometer();

    /**
     * Returns by pointer, unit of length: point.
     * Caller owns returned value and must free it.
     * Also see {@link #getPoint()}.
     * @param status ICU error code.
     * @stable ICU 59
     */
    static MeasureUnit *createPoint(UErrorCode &status);

    /**
     * Returns by value, unit of length: point.
     * Also see {@link #createPoint()}.
     * @stable ICU 64
     */
    static MeasureUnit getPoint();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: ri-jp.
     * Caller owns returned value and must free it.
     * Also see {@link #getRiJp()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createRiJp(UErrorCode &status);

    /**
     * Returns by value, unit of length: ri-jp.
     * Also see {@link #createRiJp()}.
     * @draft ICU 78
     */
    static MeasureUnit getRiJp();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: rin.
     * Caller owns returned value and must free it.
     * Also see {@link #getRin()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createRin(UErrorCode &status);

    /**
     * Returns by value, unit of length: rin.
     * Also see {@link #createRin()}.
     * @draft ICU 78
     */
    static MeasureUnit getRin();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: rod.
     * Caller owns returned value and must free it.
     * Also see {@link #getRod()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createRod(UErrorCode &status);

    /**
     * Returns by value, unit of length: rod.
     * Also see {@link #createRod()}.
     * @draft ICU 78
     */
    static MeasureUnit getRod();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: shaku-cloth.
     * Caller owns returned value and must free it.
     * Also see {@link #getShakuCloth()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createShakuCloth(UErrorCode &status);

    /**
     * Returns by value, unit of length: shaku-cloth.
     * Also see {@link #createShakuCloth()}.
     * @draft ICU 78
     */
    static MeasureUnit getShakuCloth();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: shaku-length.
     * Caller owns returned value and must free it.
     * Also see {@link #getShakuLength()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createShakuLength(UErrorCode &status);

    /**
     * Returns by value, unit of length: shaku-length.
     * Also see {@link #createShakuLength()}.
     * @draft ICU 78
     */
    static MeasureUnit getShakuLength();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of length: solar-radius.
     * Caller owns returned value and must free it.
     * Also see {@link #getSolarRadius()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createSolarRadius(UErrorCode &status);

    /**
     * Returns by value, unit of length: solar-radius.
     * Also see {@link #createSolarRadius()}.
     * @stable ICU 64
     */
    static MeasureUnit getSolarRadius();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of length: sun.
     * Caller owns returned value and must free it.
     * Also see {@link #getSun()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createSun(UErrorCode &status);

    /**
     * Returns by value, unit of length: sun.
     * Also see {@link #createSun()}.
     * @draft ICU 78
     */
    static MeasureUnit getSun();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of length: yard.
     * Caller owns returned value and must free it.
     * Also see {@link #getYard()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createYard(UErrorCode &status);

    /**
     * Returns by value, unit of length: yard.
     * Also see {@link #createYard()}.
     * @stable ICU 64
     */
    static MeasureUnit getYard();

    /**
     * Returns by pointer, unit of light: candela.
     * Caller owns returned value and must free it.
     * Also see {@link #getCandela()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createCandela(UErrorCode &status);

    /**
     * Returns by value, unit of light: candela.
     * Also see {@link #createCandela()}.
     * @stable ICU 68
     */
    static MeasureUnit getCandela();

    /**
     * Returns by pointer, unit of light: lumen.
     * Caller owns returned value and must free it.
     * Also see {@link #getLumen()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createLumen(UErrorCode &status);

    /**
     * Returns by value, unit of light: lumen.
     * Also see {@link #createLumen()}.
     * @stable ICU 68
     */
    static MeasureUnit getLumen();

    /**
     * Returns by pointer, unit of light: lux.
     * Caller owns returned value and must free it.
     * Also see {@link #getLux()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createLux(UErrorCode &status);

    /**
     * Returns by value, unit of light: lux.
     * Also see {@link #createLux()}.
     * @stable ICU 64
     */
    static MeasureUnit getLux();

    /**
     * Returns by pointer, unit of light: solar-luminosity.
     * Caller owns returned value and must free it.
     * Also see {@link #getSolarLuminosity()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createSolarLuminosity(UErrorCode &status);

    /**
     * Returns by value, unit of light: solar-luminosity.
     * Also see {@link #createSolarLuminosity()}.
     * @stable ICU 64
     */
    static MeasureUnit getSolarLuminosity();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of magnetic: tesla.
     * Caller owns returned value and must free it.
     * Also see {@link #getTesla()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createTesla(UErrorCode &status);

    /**
     * Returns by value, unit of magnetic: tesla.
     * Also see {@link #createTesla()}.
     * @draft ICU 78
     */
    static MeasureUnit getTesla();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of magnetic: weber.
     * Caller owns returned value and must free it.
     * Also see {@link #getWeber()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createWeber(UErrorCode &status);

    /**
     * Returns by value, unit of magnetic: weber.
     * Also see {@link #createWeber()}.
     * @draft ICU 78
     */
    static MeasureUnit getWeber();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of mass: carat.
     * Caller owns returned value and must free it.
     * Also see {@link #getCarat()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCarat(UErrorCode &status);

    /**
     * Returns by value, unit of mass: carat.
     * Also see {@link #createCarat()}.
     * @stable ICU 64
     */
    static MeasureUnit getCarat();

    /**
     * Returns by pointer, unit of mass: dalton.
     * Caller owns returned value and must free it.
     * Also see {@link #getDalton()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createDalton(UErrorCode &status);

    /**
     * Returns by value, unit of mass: dalton.
     * Also see {@link #createDalton()}.
     * @stable ICU 64
     */
    static MeasureUnit getDalton();

    /**
     * Returns by pointer, unit of mass: earth-mass.
     * Caller owns returned value and must free it.
     * Also see {@link #getEarthMass()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createEarthMass(UErrorCode &status);

    /**
     * Returns by value, unit of mass: earth-mass.
     * Also see {@link #createEarthMass()}.
     * @stable ICU 64
     */
    static MeasureUnit getEarthMass();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of mass: fun.
     * Caller owns returned value and must free it.
     * Also see {@link #getFun()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createFun(UErrorCode &status);

    /**
     * Returns by value, unit of mass: fun.
     * Also see {@link #createFun()}.
     * @draft ICU 78
     */
    static MeasureUnit getFun();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of mass: grain.
     * Caller owns returned value and must free it.
     * Also see {@link #getGrain()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createGrain(UErrorCode &status);

    /**
     * Returns by value, unit of mass: grain.
     * Also see {@link #createGrain()}.
     * @stable ICU 68
     */
    static MeasureUnit getGrain();

    /**
     * Returns by pointer, unit of mass: gram.
     * Caller owns returned value and must free it.
     * Also see {@link #getGram()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createGram(UErrorCode &status);

    /**
     * Returns by value, unit of mass: gram.
     * Also see {@link #createGram()}.
     * @stable ICU 64
     */
    static MeasureUnit getGram();

    /**
     * Returns by pointer, unit of mass: kilogram.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilogram()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createKilogram(UErrorCode &status);

    /**
     * Returns by value, unit of mass: kilogram.
     * Also see {@link #createKilogram()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilogram();

    /**
     * Returns by pointer, unit of mass: microgram.
     * Caller owns returned value and must free it.
     * Also see {@link #getMicrogram()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMicrogram(UErrorCode &status);

    /**
     * Returns by value, unit of mass: microgram.
     * Also see {@link #createMicrogram()}.
     * @stable ICU 64
     */
    static MeasureUnit getMicrogram();

    /**
     * Returns by pointer, unit of mass: milligram.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilligram()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMilligram(UErrorCode &status);

    /**
     * Returns by value, unit of mass: milligram.
     * Also see {@link #createMilligram()}.
     * @stable ICU 64
     */
    static MeasureUnit getMilligram();

    /**
     * Returns by pointer, unit of mass: ounce.
     * Caller owns returned value and must free it.
     * Also see {@link #getOunce()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createOunce(UErrorCode &status);

    /**
     * Returns by value, unit of mass: ounce.
     * Also see {@link #createOunce()}.
     * @stable ICU 64
     */
    static MeasureUnit getOunce();

    /**
     * Returns by pointer, unit of mass: ounce-troy.
     * Caller owns returned value and must free it.
     * Also see {@link #getOunceTroy()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createOunceTroy(UErrorCode &status);

    /**
     * Returns by value, unit of mass: ounce-troy.
     * Also see {@link #createOunceTroy()}.
     * @stable ICU 64
     */
    static MeasureUnit getOunceTroy();

    /**
     * Returns by pointer, unit of mass: pound.
     * Caller owns returned value and must free it.
     * Also see {@link #getPound()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createPound(UErrorCode &status);

    /**
     * Returns by value, unit of mass: pound.
     * Also see {@link #createPound()}.
     * @stable ICU 64
     */
    static MeasureUnit getPound();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of mass: slug.
     * Caller owns returned value and must free it.
     * Also see {@link #getSlug()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createSlug(UErrorCode &status);

    /**
     * Returns by value, unit of mass: slug.
     * Also see {@link #createSlug()}.
     * @draft ICU 78
     */
    static MeasureUnit getSlug();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of mass: solar-mass.
     * Caller owns returned value and must free it.
     * Also see {@link #getSolarMass()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createSolarMass(UErrorCode &status);

    /**
     * Returns by value, unit of mass: solar-mass.
     * Also see {@link #createSolarMass()}.
     * @stable ICU 64
     */
    static MeasureUnit getSolarMass();

    /**
     * Returns by pointer, unit of mass: stone.
     * Caller owns returned value and must free it.
     * Also see {@link #getStone()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createStone(UErrorCode &status);

    /**
     * Returns by value, unit of mass: stone.
     * Also see {@link #createStone()}.
     * @stable ICU 64
     */
    static MeasureUnit getStone();

    /**
     * Returns by pointer, unit of mass: ton.
     * Caller owns returned value and must free it.
     * Also see {@link #getTon()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createTon(UErrorCode &status);

    /**
     * Returns by value, unit of mass: ton.
     * Also see {@link #createTon()}.
     * @stable ICU 64
     */
    static MeasureUnit getTon();

    /**
     * Returns by pointer, unit of mass: tonne.
     * Caller owns returned value and must free it.
     * Also see {@link #getTonne()}.
     * @param status ICU error code.
     * @stable ICU 72
     */
    static MeasureUnit *createTonne(UErrorCode &status);

    /**
     * Returns by value, unit of mass: tonne.
     * Also see {@link #createTonne()}.
     * @stable ICU 72
     */
    static MeasureUnit getTonne();

#ifndef U_HIDE_DEPRECATED_API
    /**
     * Returns by pointer, unit of mass: metric-ton
     * (renamed to tonne in CLDR 42 / ICU 72).
     * Caller owns returned value and must free it.
     * Also see {@link #getMetricTon()} and {@link #createTonne()}.
     * @param status ICU error code.
     * @deprecated ICU 78 use createTonne(UErrorCode &status)
     */
    static MeasureUnit *createMetricTon(UErrorCode &status);

    /**
     * Returns by value, unit of mass: metric-ton
     * (renamed to tonne in CLDR 42 / ICU 72).
     * Also see {@link #createMetricTon()} and {@link #getTonne()}.
     * @deprecated ICU 78 use getTonne()
     */
    static MeasureUnit getMetricTon();
#endif  /* U_HIDE_DEPRECATED_API */

    /**
     * Returns by pointer, unit of power: gigawatt.
     * Caller owns returned value and must free it.
     * Also see {@link #getGigawatt()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createGigawatt(UErrorCode &status);

    /**
     * Returns by value, unit of power: gigawatt.
     * Also see {@link #createGigawatt()}.
     * @stable ICU 64
     */
    static MeasureUnit getGigawatt();

    /**
     * Returns by pointer, unit of power: horsepower.
     * Caller owns returned value and must free it.
     * Also see {@link #getHorsepower()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createHorsepower(UErrorCode &status);

    /**
     * Returns by value, unit of power: horsepower.
     * Also see {@link #createHorsepower()}.
     * @stable ICU 64
     */
    static MeasureUnit getHorsepower();

    /**
     * Returns by pointer, unit of power: kilowatt.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilowatt()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createKilowatt(UErrorCode &status);

    /**
     * Returns by value, unit of power: kilowatt.
     * Also see {@link #createKilowatt()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilowatt();

    /**
     * Returns by pointer, unit of power: megawatt.
     * Caller owns returned value and must free it.
     * Also see {@link #getMegawatt()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMegawatt(UErrorCode &status);

    /**
     * Returns by value, unit of power: megawatt.
     * Also see {@link #createMegawatt()}.
     * @stable ICU 64
     */
    static MeasureUnit getMegawatt();

    /**
     * Returns by pointer, unit of power: milliwatt.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilliwatt()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMilliwatt(UErrorCode &status);

    /**
     * Returns by value, unit of power: milliwatt.
     * Also see {@link #createMilliwatt()}.
     * @stable ICU 64
     */
    static MeasureUnit getMilliwatt();

    /**
     * Returns by pointer, unit of power: watt.
     * Caller owns returned value and must free it.
     * Also see {@link #getWatt()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createWatt(UErrorCode &status);

    /**
     * Returns by value, unit of power: watt.
     * Also see {@link #createWatt()}.
     * @stable ICU 64
     */
    static MeasureUnit getWatt();

    /**
     * Returns by pointer, unit of pressure: atmosphere.
     * Caller owns returned value and must free it.
     * Also see {@link #getAtmosphere()}.
     * @param status ICU error code.
     * @stable ICU 63
     */
    static MeasureUnit *createAtmosphere(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: atmosphere.
     * Also see {@link #createAtmosphere()}.
     * @stable ICU 64
     */
    static MeasureUnit getAtmosphere();

    /**
     * Returns by pointer, unit of pressure: bar.
     * Caller owns returned value and must free it.
     * Also see {@link #getBar()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createBar(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: bar.
     * Also see {@link #createBar()}.
     * @stable ICU 65
     */
    static MeasureUnit getBar();

    /**
     * Returns by pointer, unit of pressure: gasoline-energy-density.
     * Caller owns returned value and must free it.
     * Also see {@link #getGasolineEnergyDensity()}.
     * @param status ICU error code.
     * @stable ICU 74
     */
    static MeasureUnit *createGasolineEnergyDensity(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: gasoline-energy-density.
     * Also see {@link #createGasolineEnergyDensity()}.
     * @stable ICU 74
     */
    static MeasureUnit getGasolineEnergyDensity();

    /**
     * Returns by pointer, unit of pressure: hectopascal.
     * Caller owns returned value and must free it.
     * Also see {@link #getHectopascal()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createHectopascal(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: hectopascal.
     * Also see {@link #createHectopascal()}.
     * @stable ICU 64
     */
    static MeasureUnit getHectopascal();

    /**
     * Returns by pointer, unit of pressure: inch-ofhg.
     * Caller owns returned value and must free it.
     * Also see {@link #getInchHg()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createInchHg(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: inch-ofhg.
     * Also see {@link #createInchHg()}.
     * @stable ICU 64
     */
    static MeasureUnit getInchHg();

    /**
     * Returns by pointer, unit of pressure: kilopascal.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilopascal()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createKilopascal(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: kilopascal.
     * Also see {@link #createKilopascal()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilopascal();

    /**
     * Returns by pointer, unit of pressure: megapascal.
     * Caller owns returned value and must free it.
     * Also see {@link #getMegapascal()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createMegapascal(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: megapascal.
     * Also see {@link #createMegapascal()}.
     * @stable ICU 64
     */
    static MeasureUnit getMegapascal();

    /**
     * Returns by pointer, unit of pressure: millibar.
     * Caller owns returned value and must free it.
     * Also see {@link #getMillibar()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMillibar(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: millibar.
     * Also see {@link #createMillibar()}.
     * @stable ICU 64
     */
    static MeasureUnit getMillibar();

    /**
     * Returns by pointer, unit of pressure: millimeter-ofhg.
     * Caller owns returned value and must free it.
     * Also see {@link #getMillimeterOfMercury()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMillimeterOfMercury(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: millimeter-ofhg.
     * Also see {@link #createMillimeterOfMercury()}.
     * @stable ICU 64
     */
    static MeasureUnit getMillimeterOfMercury();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of pressure: ofhg.
     * Caller owns returned value and must free it.
     * Also see {@link #getOfhg()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createOfhg(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: ofhg.
     * Also see {@link #createOfhg()}.
     * @draft ICU 78
     */
    static MeasureUnit getOfhg();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of pressure: pascal.
     * Caller owns returned value and must free it.
     * Also see {@link #getPascal()}.
     * @param status ICU error code.
     * @stable ICU 65
     */
    static MeasureUnit *createPascal(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: pascal.
     * Also see {@link #createPascal()}.
     * @stable ICU 65
     */
    static MeasureUnit getPascal();

    /**
     * Returns by pointer, unit of pressure: pound-force-per-square-inch.
     * Caller owns returned value and must free it.
     * Also see {@link #getPoundPerSquareInch()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createPoundPerSquareInch(UErrorCode &status);

    /**
     * Returns by value, unit of pressure: pound-force-per-square-inch.
     * Also see {@link #createPoundPerSquareInch()}.
     * @stable ICU 64
     */
    static MeasureUnit getPoundPerSquareInch();

    /**
     * Returns by pointer, unit of speed: beaufort.
     * Caller owns returned value and must free it.
     * Also see {@link #getBeaufort()}.
     * @param status ICU error code.
     * @stable ICU 73
     */
    static MeasureUnit *createBeaufort(UErrorCode &status);

    /**
     * Returns by value, unit of speed: beaufort.
     * Also see {@link #createBeaufort()}.
     * @stable ICU 73
     */
    static MeasureUnit getBeaufort();

    /**
     * Returns by pointer, unit of speed: kilometer-per-hour.
     * Caller owns returned value and must free it.
     * Also see {@link #getKilometerPerHour()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createKilometerPerHour(UErrorCode &status);

    /**
     * Returns by value, unit of speed: kilometer-per-hour.
     * Also see {@link #createKilometerPerHour()}.
     * @stable ICU 64
     */
    static MeasureUnit getKilometerPerHour();

    /**
     * Returns by pointer, unit of speed: knot.
     * Caller owns returned value and must free it.
     * Also see {@link #getKnot()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createKnot(UErrorCode &status);

    /**
     * Returns by value, unit of speed: knot.
     * Also see {@link #createKnot()}.
     * @stable ICU 64
     */
    static MeasureUnit getKnot();

    /**
     * Returns by pointer, unit of speed: light-speed.
     * Caller owns returned value and must free it.
     * Also see {@link #getLightSpeed()}.
     * @param status ICU error code.
     * @stable ICU 76
     */
    static MeasureUnit *createLightSpeed(UErrorCode &status);

    /**
     * Returns by value, unit of speed: light-speed.
     * Also see {@link #createLightSpeed()}.
     * @stable ICU 76
     */
    static MeasureUnit getLightSpeed();

    /**
     * Returns by pointer, unit of speed: meter-per-second.
     * Caller owns returned value and must free it.
     * Also see {@link #getMeterPerSecond()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMeterPerSecond(UErrorCode &status);

    /**
     * Returns by value, unit of speed: meter-per-second.
     * Also see {@link #createMeterPerSecond()}.
     * @stable ICU 64
     */
    static MeasureUnit getMeterPerSecond();

    /**
     * Returns by pointer, unit of speed: mile-per-hour.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilePerHour()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createMilePerHour(UErrorCode &status);

    /**
     * Returns by value, unit of speed: mile-per-hour.
     * Also see {@link #createMilePerHour()}.
     * @stable ICU 64
     */
    static MeasureUnit getMilePerHour();

    /**
     * Returns by pointer, unit of temperature: celsius.
     * Caller owns returned value and must free it.
     * Also see {@link #getCelsius()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createCelsius(UErrorCode &status);

    /**
     * Returns by value, unit of temperature: celsius.
     * Also see {@link #createCelsius()}.
     * @stable ICU 64
     */
    static MeasureUnit getCelsius();

    /**
     * Returns by pointer, unit of temperature: fahrenheit.
     * Caller owns returned value and must free it.
     * Also see {@link #getFahrenheit()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createFahrenheit(UErrorCode &status);

    /**
     * Returns by value, unit of temperature: fahrenheit.
     * Also see {@link #createFahrenheit()}.
     * @stable ICU 64
     */
    static MeasureUnit getFahrenheit();

    /**
     * Returns by pointer, unit of temperature: generic.
     * Caller owns returned value and must free it.
     * Also see {@link #getGenericTemperature()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createGenericTemperature(UErrorCode &status);

    /**
     * Returns by value, unit of temperature: generic.
     * Also see {@link #createGenericTemperature()}.
     * @stable ICU 64
     */
    static MeasureUnit getGenericTemperature();

    /**
     * Returns by pointer, unit of temperature: kelvin.
     * Caller owns returned value and must free it.
     * Also see {@link #getKelvin()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createKelvin(UErrorCode &status);

    /**
     * Returns by value, unit of temperature: kelvin.
     * Also see {@link #createKelvin()}.
     * @stable ICU 64
     */
    static MeasureUnit getKelvin();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of temperature: rankine.
     * Caller owns returned value and must free it.
     * Also see {@link #getRankine()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createRankine(UErrorCode &status);

    /**
     * Returns by value, unit of temperature: rankine.
     * Also see {@link #createRankine()}.
     * @draft ICU 78
     */
    static MeasureUnit getRankine();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of torque: newton-meter.
     * Caller owns returned value and must free it.
     * Also see {@link #getNewtonMeter()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createNewtonMeter(UErrorCode &status);

    /**
     * Returns by value, unit of torque: newton-meter.
     * Also see {@link #createNewtonMeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getNewtonMeter();

    /**
     * Returns by pointer, unit of torque: pound-force-foot.
     * Caller owns returned value and must free it.
     * Also see {@link #getPoundFoot()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createPoundFoot(UErrorCode &status);

    /**
     * Returns by value, unit of torque: pound-force-foot.
     * Also see {@link #createPoundFoot()}.
     * @stable ICU 64
     */
    static MeasureUnit getPoundFoot();

    /**
     * Returns by pointer, unit of volume: acre-foot.
     * Caller owns returned value and must free it.
     * Also see {@link #getAcreFoot()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createAcreFoot(UErrorCode &status);

    /**
     * Returns by value, unit of volume: acre-foot.
     * Also see {@link #createAcreFoot()}.
     * @stable ICU 64
     */
    static MeasureUnit getAcreFoot();

    /**
     * Returns by pointer, unit of volume: barrel.
     * Caller owns returned value and must free it.
     * Also see {@link #getBarrel()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createBarrel(UErrorCode &status);

    /**
     * Returns by value, unit of volume: barrel.
     * Also see {@link #createBarrel()}.
     * @stable ICU 64
     */
    static MeasureUnit getBarrel();

    /**
     * Returns by pointer, unit of volume: bushel.
     * Caller owns returned value and must free it.
     * Also see {@link #getBushel()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createBushel(UErrorCode &status);

    /**
     * Returns by value, unit of volume: bushel.
     * Also see {@link #createBushel()}.
     * @stable ICU 64
     */
    static MeasureUnit getBushel();

    /**
     * Returns by pointer, unit of volume: centiliter.
     * Caller owns returned value and must free it.
     * Also see {@link #getCentiliter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCentiliter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: centiliter.
     * Also see {@link #createCentiliter()}.
     * @stable ICU 64
     */
    static MeasureUnit getCentiliter();

    /**
     * Returns by pointer, unit of volume: cubic-centimeter.
     * Caller owns returned value and must free it.
     * Also see {@link #getCubicCentimeter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCubicCentimeter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cubic-centimeter.
     * Also see {@link #createCubicCentimeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getCubicCentimeter();

    /**
     * Returns by pointer, unit of volume: cubic-foot.
     * Caller owns returned value and must free it.
     * Also see {@link #getCubicFoot()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCubicFoot(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cubic-foot.
     * Also see {@link #createCubicFoot()}.
     * @stable ICU 64
     */
    static MeasureUnit getCubicFoot();

    /**
     * Returns by pointer, unit of volume: cubic-inch.
     * Caller owns returned value and must free it.
     * Also see {@link #getCubicInch()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCubicInch(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cubic-inch.
     * Also see {@link #createCubicInch()}.
     * @stable ICU 64
     */
    static MeasureUnit getCubicInch();

    /**
     * Returns by pointer, unit of volume: cubic-kilometer.
     * Caller owns returned value and must free it.
     * Also see {@link #getCubicKilometer()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createCubicKilometer(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cubic-kilometer.
     * Also see {@link #createCubicKilometer()}.
     * @stable ICU 64
     */
    static MeasureUnit getCubicKilometer();

    /**
     * Returns by pointer, unit of volume: cubic-meter.
     * Caller owns returned value and must free it.
     * Also see {@link #getCubicMeter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCubicMeter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cubic-meter.
     * Also see {@link #createCubicMeter()}.
     * @stable ICU 64
     */
    static MeasureUnit getCubicMeter();

    /**
     * Returns by pointer, unit of volume: cubic-mile.
     * Caller owns returned value and must free it.
     * Also see {@link #getCubicMile()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createCubicMile(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cubic-mile.
     * Also see {@link #createCubicMile()}.
     * @stable ICU 64
     */
    static MeasureUnit getCubicMile();

    /**
     * Returns by pointer, unit of volume: cubic-yard.
     * Caller owns returned value and must free it.
     * Also see {@link #getCubicYard()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCubicYard(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cubic-yard.
     * Also see {@link #createCubicYard()}.
     * @stable ICU 64
     */
    static MeasureUnit getCubicYard();

    /**
     * Returns by pointer, unit of volume: cup.
     * Caller owns returned value and must free it.
     * Also see {@link #getCup()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createCup(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cup.
     * Also see {@link #createCup()}.
     * @stable ICU 64
     */
    static MeasureUnit getCup();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: cup-imperial.
     * Caller owns returned value and must free it.
     * Also see {@link #getCupImperial()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createCupImperial(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cup-imperial.
     * Also see {@link #createCupImperial()}.
     * @draft ICU 78
     */
    static MeasureUnit getCupImperial();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: cup-jp.
     * Caller owns returned value and must free it.
     * Also see {@link #getCupJp()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createCupJp(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cup-jp.
     * Also see {@link #createCupJp()}.
     * @draft ICU 78
     */
    static MeasureUnit getCupJp();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of volume: cup-metric.
     * Caller owns returned value and must free it.
     * Also see {@link #getCupMetric()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createCupMetric(UErrorCode &status);

    /**
     * Returns by value, unit of volume: cup-metric.
     * Also see {@link #createCupMetric()}.
     * @stable ICU 64
     */
    static MeasureUnit getCupMetric();

    /**
     * Returns by pointer, unit of volume: deciliter.
     * Caller owns returned value and must free it.
     * Also see {@link #getDeciliter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createDeciliter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: deciliter.
     * Also see {@link #createDeciliter()}.
     * @stable ICU 64
     */
    static MeasureUnit getDeciliter();

    /**
     * Returns by pointer, unit of volume: dessert-spoon.
     * Caller owns returned value and must free it.
     * Also see {@link #getDessertSpoon()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createDessertSpoon(UErrorCode &status);

    /**
     * Returns by value, unit of volume: dessert-spoon.
     * Also see {@link #createDessertSpoon()}.
     * @stable ICU 68
     */
    static MeasureUnit getDessertSpoon();

    /**
     * Returns by pointer, unit of volume: dessert-spoon-imperial.
     * Caller owns returned value and must free it.
     * Also see {@link #getDessertSpoonImperial()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createDessertSpoonImperial(UErrorCode &status);

    /**
     * Returns by value, unit of volume: dessert-spoon-imperial.
     * Also see {@link #createDessertSpoonImperial()}.
     * @stable ICU 68
     */
    static MeasureUnit getDessertSpoonImperial();

    /**
     * Returns by pointer, unit of volume: dram.
     * Caller owns returned value and must free it.
     * Also see {@link #getDram()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createDram(UErrorCode &status);

    /**
     * Returns by value, unit of volume: dram.
     * Also see {@link #createDram()}.
     * @stable ICU 68
     */
    static MeasureUnit getDram();

    /**
     * Returns by pointer, unit of volume: drop.
     * Caller owns returned value and must free it.
     * Also see {@link #getDrop()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createDrop(UErrorCode &status);

    /**
     * Returns by value, unit of volume: drop.
     * Also see {@link #createDrop()}.
     * @stable ICU 68
     */
    static MeasureUnit getDrop();

    /**
     * Returns by pointer, unit of volume: fluid-ounce.
     * Caller owns returned value and must free it.
     * Also see {@link #getFluidOunce()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createFluidOunce(UErrorCode &status);

    /**
     * Returns by value, unit of volume: fluid-ounce.
     * Also see {@link #createFluidOunce()}.
     * @stable ICU 64
     */
    static MeasureUnit getFluidOunce();

    /**
     * Returns by pointer, unit of volume: fluid-ounce-imperial.
     * Caller owns returned value and must free it.
     * Also see {@link #getFluidOunceImperial()}.
     * @param status ICU error code.
     * @stable ICU 64
     */
    static MeasureUnit *createFluidOunceImperial(UErrorCode &status);

    /**
     * Returns by value, unit of volume: fluid-ounce-imperial.
     * Also see {@link #createFluidOunceImperial()}.
     * @stable ICU 64
     */
    static MeasureUnit getFluidOunceImperial();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: fluid-ounce-metric.
     * Caller owns returned value and must free it.
     * Also see {@link #getFluidOunceMetric()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createFluidOunceMetric(UErrorCode &status);

    /**
     * Returns by value, unit of volume: fluid-ounce-metric.
     * Also see {@link #createFluidOunceMetric()}.
     * @draft ICU 78
     */
    static MeasureUnit getFluidOunceMetric();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of volume: gallon.
     * Caller owns returned value and must free it.
     * Also see {@link #getGallon()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createGallon(UErrorCode &status);

    /**
     * Returns by value, unit of volume: gallon.
     * Also see {@link #createGallon()}.
     * @stable ICU 64
     */
    static MeasureUnit getGallon();

    /**
     * Returns by pointer, unit of volume: gallon-imperial.
     * Caller owns returned value and must free it.
     * Also see {@link #getGallonImperial()}.
     * @param status ICU error code.
     * @stable ICU 57
     */
    static MeasureUnit *createGallonImperial(UErrorCode &status);

    /**
     * Returns by value, unit of volume: gallon-imperial.
     * Also see {@link #createGallonImperial()}.
     * @stable ICU 64
     */
    static MeasureUnit getGallonImperial();

    /**
     * Returns by pointer, unit of volume: hectoliter.
     * Caller owns returned value and must free it.
     * Also see {@link #getHectoliter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createHectoliter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: hectoliter.
     * Also see {@link #createHectoliter()}.
     * @stable ICU 64
     */
    static MeasureUnit getHectoliter();

    /**
     * Returns by pointer, unit of volume: jigger.
     * Caller owns returned value and must free it.
     * Also see {@link #getJigger()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createJigger(UErrorCode &status);

    /**
     * Returns by value, unit of volume: jigger.
     * Also see {@link #createJigger()}.
     * @stable ICU 68
     */
    static MeasureUnit getJigger();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: koku.
     * Caller owns returned value and must free it.
     * Also see {@link #getKoku()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createKoku(UErrorCode &status);

    /**
     * Returns by value, unit of volume: koku.
     * Also see {@link #createKoku()}.
     * @draft ICU 78
     */
    static MeasureUnit getKoku();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: kosaji.
     * Caller owns returned value and must free it.
     * Also see {@link #getKosaji()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createKosaji(UErrorCode &status);

    /**
     * Returns by value, unit of volume: kosaji.
     * Also see {@link #createKosaji()}.
     * @draft ICU 78
     */
    static MeasureUnit getKosaji();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of volume: liter.
     * Caller owns returned value and must free it.
     * Also see {@link #getLiter()}.
     * @param status ICU error code.
     * @stable ICU 53
     */
    static MeasureUnit *createLiter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: liter.
     * Also see {@link #createLiter()}.
     * @stable ICU 64
     */
    static MeasureUnit getLiter();

    /**
     * Returns by pointer, unit of volume: megaliter.
     * Caller owns returned value and must free it.
     * Also see {@link #getMegaliter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMegaliter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: megaliter.
     * Also see {@link #createMegaliter()}.
     * @stable ICU 64
     */
    static MeasureUnit getMegaliter();

    /**
     * Returns by pointer, unit of volume: milliliter.
     * Caller owns returned value and must free it.
     * Also see {@link #getMilliliter()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createMilliliter(UErrorCode &status);

    /**
     * Returns by value, unit of volume: milliliter.
     * Also see {@link #createMilliliter()}.
     * @stable ICU 64
     */
    static MeasureUnit getMilliliter();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: osaji.
     * Caller owns returned value and must free it.
     * Also see {@link #getOsaji()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createOsaji(UErrorCode &status);

    /**
     * Returns by value, unit of volume: osaji.
     * Also see {@link #createOsaji()}.
     * @draft ICU 78
     */
    static MeasureUnit getOsaji();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of volume: pinch.
     * Caller owns returned value and must free it.
     * Also see {@link #getPinch()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createPinch(UErrorCode &status);

    /**
     * Returns by value, unit of volume: pinch.
     * Also see {@link #createPinch()}.
     * @stable ICU 68
     */
    static MeasureUnit getPinch();

    /**
     * Returns by pointer, unit of volume: pint.
     * Caller owns returned value and must free it.
     * Also see {@link #getPint()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createPint(UErrorCode &status);

    /**
     * Returns by value, unit of volume: pint.
     * Also see {@link #createPint()}.
     * @stable ICU 64
     */
    static MeasureUnit getPint();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: pint-imperial.
     * Caller owns returned value and must free it.
     * Also see {@link #getPintImperial()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createPintImperial(UErrorCode &status);

    /**
     * Returns by value, unit of volume: pint-imperial.
     * Also see {@link #createPintImperial()}.
     * @draft ICU 78
     */
    static MeasureUnit getPintImperial();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of volume: pint-metric.
     * Caller owns returned value and must free it.
     * Also see {@link #getPintMetric()}.
     * @param status ICU error code.
     * @stable ICU 56
     */
    static MeasureUnit *createPintMetric(UErrorCode &status);

    /**
     * Returns by value, unit of volume: pint-metric.
     * Also see {@link #createPintMetric()}.
     * @stable ICU 64
     */
    static MeasureUnit getPintMetric();

    /**
     * Returns by pointer, unit of volume: quart.
     * Caller owns returned value and must free it.
     * Also see {@link #getQuart()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createQuart(UErrorCode &status);

    /**
     * Returns by value, unit of volume: quart.
     * Also see {@link #createQuart()}.
     * @stable ICU 64
     */
    static MeasureUnit getQuart();

    /**
     * Returns by pointer, unit of volume: quart-imperial.
     * Caller owns returned value and must free it.
     * Also see {@link #getQuartImperial()}.
     * @param status ICU error code.
     * @stable ICU 68
     */
    static MeasureUnit *createQuartImperial(UErrorCode &status);

    /**
     * Returns by value, unit of volume: quart-imperial.
     * Also see {@link #createQuartImperial()}.
     * @stable ICU 68
     */
    static MeasureUnit getQuartImperial();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: sai.
     * Caller owns returned value and must free it.
     * Also see {@link #getSai()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createSai(UErrorCode &status);

    /**
     * Returns by value, unit of volume: sai.
     * Also see {@link #createSai()}.
     * @draft ICU 78
     */
    static MeasureUnit getSai();
#endif /* U_HIDE_DRAFT_API */

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: shaku.
     * Caller owns returned value and must free it.
     * Also see {@link #getShaku()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createShaku(UErrorCode &status);

    /**
     * Returns by value, unit of volume: shaku.
     * Also see {@link #createShaku()}.
     * @draft ICU 78
     */
    static MeasureUnit getShaku();
#endif /* U_HIDE_DRAFT_API */

    /**
     * Returns by pointer, unit of volume: tablespoon.
     * Caller owns returned value and must free it.
     * Also see {@link #getTablespoon()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createTablespoon(UErrorCode &status);

    /**
     * Returns by value, unit of volume: tablespoon.
     * Also see {@link #createTablespoon()}.
     * @stable ICU 64
     */
    static MeasureUnit getTablespoon();

    /**
     * Returns by pointer, unit of volume: teaspoon.
     * Caller owns returned value and must free it.
     * Also see {@link #getTeaspoon()}.
     * @param status ICU error code.
     * @stable ICU 54
     */
    static MeasureUnit *createTeaspoon(UErrorCode &status);

    /**
     * Returns by value, unit of volume: teaspoon.
     * Also see {@link #createTeaspoon()}.
     * @stable ICU 64
     */
    static MeasureUnit getTeaspoon();

#ifndef U_HIDE_DRAFT_API
    /**
     * Returns by pointer, unit of volume: to-jp.
     * Caller owns returned value and must free it.
     * Also see {@link #getToJp()}.
     * @param status ICU error code.
     * @draft ICU 78
     */
    static MeasureUnit *createToJp(UErrorCode &status);

    /**
     * Returns by value, unit of volume: to-jp.
     * Also see {@link #createToJp()}.
     * @draft ICU 78
     */
    static MeasureUnit getToJp();
#endif /* U_HIDE_DRAFT_API */

// End generated createXXX methods

 protected:

#ifndef U_HIDE_INTERNAL_API
    /**
     * For ICU use only.
     * @internal
     */
    void initTime(const char *timeId);

    /**
     * For ICU use only.
     * @internal
     */
    void initCurrency(StringPiece isoCurrency);

#endif  /* U_HIDE_INTERNAL_API */

private:

    // Used by new draft APIs in ICU 67. If non-null, fImpl is owned by the
    // MeasureUnit.
    MeasureUnitImpl* fImpl;

    // An index into a static string list in measunit.cpp. If set to -1, fImpl
    // is in use instead of fTypeId and fSubTypeId.
    int16_t fSubTypeId;
    // An index into a static string list in measunit.cpp. If set to -1, fImpl
    // is in use instead of fTypeId and fSubTypeId.
    int8_t fTypeId;

    MeasureUnit(int32_t typeId, int32_t subTypeId);
    MeasureUnit(MeasureUnitImpl&& impl);
    void setTo(int32_t typeId, int32_t subTypeId);
    static MeasureUnit *create(int typeId, int subTypeId, UErrorCode &status);

    /**
     * Sets output's typeId and subTypeId according to subType, if subType is a
     * valid/known identifier.
     *
     * @return Whether subType is known to ICU. If false, output was not
     * modified.
     */
    static bool findBySubType(StringPiece subType, MeasureUnit* output);

    /** Internal version of public API */
    LocalArray<MeasureUnit> splitToSingleUnitsImpl(int32_t& outCount, UErrorCode& status) const;

    friend class MeasureUnitImpl;

    // For access to findBySubType
    friend class number::impl::LongNameHandler;
};

// inline impl of @stable ICU 68 method
inline std::pair<LocalArray<MeasureUnit>, int32_t>
MeasureUnit::splitToSingleUnits(UErrorCode& status) const {
    int32_t length;
    auto array = splitToSingleUnitsImpl(length, status);
    return std::make_pair(std::move(array), length);
}

U_NAMESPACE_END

#endif // !UNCONFIG_NO_FORMATTING

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __MEASUREUNIT_H__
