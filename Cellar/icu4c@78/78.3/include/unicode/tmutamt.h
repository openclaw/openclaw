// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 2009-2010, Google, International Business Machines Corporation and *
 * others. All Rights Reserved.                                                *
 *******************************************************************************
 */ 

#ifndef __TMUTAMT_H__
#define __TMUTAMT_H__


/**
 * \file
 * \brief C++ API: time unit amount object.
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/measure.h"
#include "unicode/tmunit.h"

U_NAMESPACE_BEGIN


/**
 * Express a duration as a time unit and number. Patterned after Currency.
 * @see TimeUnitAmount
 * @see TimeUnitFormat
 * @stable ICU 4.2
 */
class U_I18N_API TimeUnitAmount: public Measure {
public:
    /**
     * Construct TimeUnitAmount object with the given number and the
     * given time unit. 
     * @param number        a numeric object; number.isNumeric() must be true
     * @param timeUnitField the time unit field of a time unit
     * @param status        the input-output error code. 
     *                      If the number is not numeric or the timeUnitField
     *                      is not valid,
     *                      then this will be set to a failing value:
     *                      U_ILLEGAL_ARGUMENT_ERROR.
     * @stable ICU 4.2
     */
    TimeUnitAmount(const Formattable& number, 
                   TimeUnit::UTimeUnitFields timeUnitField,
                   UErrorCode& status);

    /**
     * Construct TimeUnitAmount object with the given numeric amount and the
     * given time unit. 
     * @param amount        a numeric amount.
     * @param timeUnitField the time unit field on which a time unit amount
     *                      object will be created.
     * @param status        the input-output error code. 
     *                      If the timeUnitField is not valid,
     *                      then this will be set to a failing value:
     *                      U_ILLEGAL_ARGUMENT_ERROR.
     * @stable ICU 4.2
     */
    TimeUnitAmount(double amount, TimeUnit::UTimeUnitFields timeUnitField,
                   UErrorCode& status);


    /**
     * Copy constructor 
     * @stable ICU 4.2
     */
    TimeUnitAmount(const TimeUnitAmount& other);


    /**
     * Assignment operator
     * @stable ICU 4.2
     */
    TimeUnitAmount& operator=(const TimeUnitAmount& other);


    /**
     * Clone. 
     * @return a polymorphic clone of this object. The result will have the same               class as returned by getDynamicClassID().
     * @stable ICU 4.2
     */
    virtual TimeUnitAmount* clone() const override;

    
    /**
     * Destructor
     * @stable ICU 4.2
     */
    virtual ~TimeUnitAmount();

    
    /** 
     * Equality operator.  
     * @param other  the object to compare to.
     * @return       true if this object is equal to the given object.
     * @stable ICU 4.2
     */
    virtual bool operator==(const UObject& other) const;


    /** 
     * Not-equality operator.  
     * @param other  the object to compare to.
     * @return       true if this object is not equal to the given object.
     * @stable ICU 4.2
     */
    bool operator!=(const UObject& other) const;


    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       erived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 4.2
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
     * @stable ICU 4.2
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * Get the time unit.
     * @return time unit object.
     * @stable ICU 4.2
     */
    const TimeUnit& getTimeUnit() const;

    /**
     * Get the time unit field value.
     * @return time unit field value.
     * @stable ICU 4.2
     */
    TimeUnit::UTimeUnitFields getTimeUnitField() const;
};



inline bool
TimeUnitAmount::operator!=(const UObject& other) const {
    return !operator==(other);
}

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __TMUTAMT_H__
//eof
//
