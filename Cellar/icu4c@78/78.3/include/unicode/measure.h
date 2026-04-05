// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
* Copyright (c) 2004-2015, International Business Machines
* Corporation and others.  All Rights Reserved.
**********************************************************************
* Author: Alan Liu
* Created: April 26, 2004
* Since: ICU 3.0
**********************************************************************
*/
#ifndef __MEASURE_H__
#define __MEASURE_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: MeasureUnit object.
 */
 
#if !UCONFIG_NO_FORMATTING

#include "unicode/fmtable.h"

U_NAMESPACE_BEGIN

class MeasureUnit;

/**
 * An amount of a specified unit, consisting of a number and a Unit.
 * For example, a length measure consists of a number and a length
 * unit, such as feet or meters.
 *
 * <p>Measure objects are formatted by MeasureFormat.
 *
 * <p>Measure objects are immutable.
 *
 * @author Alan Liu
 * @stable ICU 3.0
 */
class U_I18N_API Measure: public UObject {
 public:
    /**
     * Construct an object with the given numeric amount and the given
     * unit.  After this call, the caller must not delete the given
     * unit object.
     * @param number a numeric object; amount.isNumeric() must be true
     * @param adoptedUnit the unit object, which must not be nullptr
     * @param ec input-output error code. If the amount or the unit
     * is invalid, then this will be set to a failing value.
     * @stable ICU 3.0
     */
    Measure(const Formattable& number, MeasureUnit* adoptedUnit,
            UErrorCode& ec);

    /**
     * Copy constructor
     * @stable ICU 3.0
     */
    Measure(const Measure& other);

    /**
     * Assignment operator
     * @stable ICU 3.0
     */
    Measure& operator=(const Measure& other);

    /**
     * Return a polymorphic clone of this object.  The result will
     * have the same class as returned by getDynamicClassID().
     * @stable ICU 3.0
     */
    virtual Measure* clone() const;

    /**
     * Destructor
     * @stable ICU 3.0
     */
    virtual ~Measure();
    
    /**
     * Equality operator.  Return true if this object is equal
     * to the given object.
     * @stable ICU 3.0
     */
    bool operator==(const UObject& other) const;

    /**
     * Inequality operator.  Returns true if this object is not equal to the other object.
     * @param other the object to compare with
     * @return true if the objects are not equal
     * @stable ICU 74
     */
    inline bool operator!=(const UObject& other) const { return !operator==(other); }

    /**
     * Return a reference to the numeric value of this object.  The
     * numeric value may be of any numeric type supported by
     * Formattable.
     * @stable ICU 3.0
     */
    inline const Formattable& getNumber() const;

    /**
     * Return a reference to the unit of this object.
     * @stable ICU 3.0
     */
    inline const MeasureUnit& getUnit() const;

    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       erived::getStaticClassID()) ...
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

 protected:
    /**
     * Default constructor.
     * @stable ICU 3.0
     */
    Measure();

 private:
    /**
     * The numeric value of this object, e.g. 2.54 or 100.
     */
    Formattable number;

    /**
     * The unit of this object, e.g., "millimeter" or "JPY".  This is
     * owned by this object.
     */
    MeasureUnit* unit;
};

inline const Formattable& Measure::getNumber() const {
    return number;
}

inline const MeasureUnit& Measure::getUnit() const {
    return *unit;
}

U_NAMESPACE_END

#endif // !UCONFIG_NO_FORMATTING

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __MEASURE_H__
