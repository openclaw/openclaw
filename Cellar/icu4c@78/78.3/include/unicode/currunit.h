// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
* Copyright (c) 2004-2014, International Business Machines
* Corporation and others.  All Rights Reserved.
**********************************************************************
* Author: Alan Liu
* Created: April 26, 2004
* Since: ICU 3.0
**********************************************************************
*/
#ifndef __CURRENCYUNIT_H__
#define __CURRENCYUNIT_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/measunit.h"

/**
 * \file 
 * \brief C++ API: Currency Unit Information.
 */
 
U_NAMESPACE_BEGIN

/**
 * A unit of currency, such as USD (U.S. dollars) or JPY (Japanese
 * yen).  This class is a thin wrapper over a char16_t string that
 * subclasses MeasureUnit, for use with Measure and MeasureFormat.
 *
 * @author Alan Liu
 * @stable ICU 3.0
 */
class U_I18N_API CurrencyUnit: public MeasureUnit {
 public:
    /**
     * Default constructor.  Initializes currency code to "XXX" (no currency).
     * @stable ICU 60
     */
    CurrencyUnit();

    /**
     * Construct an object with the given ISO currency code.
     *
     * @param isoCode the 3-letter ISO 4217 currency code; must have
     * length 3 and need not be NUL-terminated. If nullptr, the currency
     * is initialized to the unknown currency XXX.
     * @param ec input-output error code. If the isoCode is invalid,
     * then this will be set to a failing value.
     * @stable ICU 3.0
     */
    CurrencyUnit(ConstChar16Ptr isoCode, UErrorCode &ec);

    /**
     * Construct an object with the given ISO currency code.
     *
     * @param isoCode the 3-letter ISO 4217 currency code; must have
     * length 3. If invalid, the currency is initialized to XXX.
     * @param ec input-output error code. If the isoCode is invalid,
     * then this will be set to a failing value.
     * @stable ICU 64
     */
    CurrencyUnit(StringPiece isoCode, UErrorCode &ec);

    /**
     * Copy constructor
     * @stable ICU 3.0
     */
    CurrencyUnit(const CurrencyUnit& other);

    /**
     * Copy constructor from MeasureUnit. This constructor allows you to
     * restore a CurrencyUnit that was sliced to MeasureUnit.
     *
     * @param measureUnit The MeasureUnit to copy from.
     * @param ec Set to a failing value if the MeasureUnit is not a currency.
     * @stable ICU 60
     */
    CurrencyUnit(const MeasureUnit& measureUnit, UErrorCode &ec);

    /**
     * Assignment operator
     * @stable ICU 3.0
     */
    CurrencyUnit& operator=(const CurrencyUnit& other);

    /**
     * Return a polymorphic clone of this object.  The result will
     * have the same class as returned by getDynamicClassID().
     * @stable ICU 3.0
     */
    virtual CurrencyUnit* clone() const override;

    /**
     * Destructor
     * @stable ICU 3.0
     */
    virtual ~CurrencyUnit();

    /**
     * Returns a unique class ID for this object POLYMORPHICALLY.
     * This method implements a simple form of RTTI used by ICU.
     * @return The class ID for this object. All objects of a given
     * class have the same class ID.  Objects of other classes have
     * different class IDs.
     * @stable ICU 3.0
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * Returns the class ID for this class. This is used to compare to
     * the return value of getDynamicClassID().
     * @return The class ID for all objects of this class.
     * @stable ICU 3.0
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Return the ISO currency code of this object.
     * @stable ICU 3.0
     */
    inline const char16_t* getISOCurrency() const;

 private:
    /**
     * The ISO 4217 code of this object.
     */
    char16_t isoCode[4];
};

inline const char16_t* CurrencyUnit::getISOCurrency() const {
    return isoCode;
}

U_NAMESPACE_END

#endif // !UCONFIG_NO_FORMATTING

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // __CURRENCYUNIT_H__
