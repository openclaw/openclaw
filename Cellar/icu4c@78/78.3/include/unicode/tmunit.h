// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 *******************************************************************************
 * Copyright (C) 2009-2016, International Business Machines Corporation,       *
 * Google, and others. All Rights Reserved.                                    *
 *******************************************************************************
 */

#ifndef __TMUNIT_H__
#define __TMUNIT_H__


/**
 * \file
 * \brief C++ API: time unit object
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/measunit.h"

#if !UCONFIG_NO_FORMATTING

U_NAMESPACE_BEGIN

/**
 * Measurement unit for time units.
 * @see TimeUnitAmount
 * @see TimeUnit
 * @stable ICU 4.2
 */
class U_I18N_API TimeUnit: public MeasureUnit {
public:
    /**
     * Constants for all the time units we supported.
     * @stable ICU 4.2
     */
    enum UTimeUnitFields {
        UTIMEUNIT_YEAR,
        UTIMEUNIT_MONTH,
        UTIMEUNIT_DAY,
        UTIMEUNIT_WEEK,
        UTIMEUNIT_HOUR,
        UTIMEUNIT_MINUTE,
        UTIMEUNIT_SECOND,
#ifndef U_HIDE_DEPRECATED_API
        /**
         * One more than the highest normal UTimeUnitFields value.
         * @deprecated ICU 58 The numeric value may change over time, see ICU ticket #12420.
         */
        UTIMEUNIT_FIELD_COUNT
#endif  // U_HIDE_DEPRECATED_API
    };

    /**
     * Create Instance.
     * @param timeUnitField  time unit field based on which the instance
     *                       is created.
     * @param status         input-output error code.
     *                       If the timeUnitField is invalid,
     *                       then this will be set to U_ILLEGAL_ARGUMENT_ERROR.
     * @return               a TimeUnit instance
     * @stable ICU 4.2
     */
    static TimeUnit* U_EXPORT2 createInstance(UTimeUnitFields timeUnitField,
                                              UErrorCode& status);


    /**
     * Override clone.
     * @stable ICU 4.2
     */
    virtual TimeUnit* clone() const override;

    /**
     * Copy operator.
     * @stable ICU 4.2
     */
    TimeUnit(const TimeUnit& other);

    /**
     * Assignment operator.
     * @stable ICU 4.2
     */
    TimeUnit& operator=(const TimeUnit& other);

    /**
     * Returns a unique class ID for this object POLYMORPHICALLY.
     * This method implements a simple form of RTTI used by ICU.
     * @return The class ID for this object. All objects of a given
     * class have the same class ID.  Objects of other classes have
     * different class IDs.
     * @stable ICU 4.2
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * Returns the class ID for this class. This is used to compare to
     * the return value of getDynamicClassID().
     * @return The class ID for all objects of this class.
     * @stable ICU 4.2
     */
    static UClassID U_EXPORT2 getStaticClassID();


    /**
     * Get time unit field.
     * @return time unit field.
     * @stable ICU 4.2
     */
    UTimeUnitFields getTimeUnitField() const;

    /**
     * Destructor.
     * @stable ICU 4.2
     */
    virtual ~TimeUnit();

private:
    UTimeUnitFields fTimeUnitField;

    /**
     * Constructor
     */
    TimeUnit(UTimeUnitFields timeUnitField);

};


U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __TMUNIT_H__
//eof
//
