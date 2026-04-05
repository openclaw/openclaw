// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
 ********************************************************************************
 *   Copyright (C) 1997-2006, International Business Machines
 *   Corporation and others.  All Rights Reserved.
 ********************************************************************************
 *
 * File FIELDPOS.H
 *
 * Modification History:
 *
 *   Date        Name        Description
 *   02/25/97    aliu        Converted from java.
 *   03/17/97    clhuang     Updated per Format implementation.
 *    07/17/98    stephen        Added default/copy ctors, and operators =, ==, !=
 ********************************************************************************
 */

// *****************************************************************************
// This file was generated from the java source file FieldPosition.java
// *****************************************************************************
 
#ifndef FIELDPOS_H
#define FIELDPOS_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

/**
 * \file 
 * \brief C++ API: FieldPosition identifies the fields in a formatted output.
 */

#if !UCONFIG_NO_FORMATTING

#include "unicode/uobject.h"

U_NAMESPACE_BEGIN

/**
 * <code>FieldPosition</code> is a simple class used by <code>Format</code>
 * and its subclasses to identify fields in formatted output. Fields are
 * identified by constants, whose names typically end with <code>_FIELD</code>,
 * defined in the various subclasses of <code>Format</code>. See
 * <code>ERA_FIELD</code> and its friends in <code>DateFormat</code> for
 * an example.
 *
 * <p>
 * <code>FieldPosition</code> keeps track of the position of the
 * field within the formatted output with two indices: the index
 * of the first character of the field and the index of the last
 * character of the field.
 *
 * <p>
 * One version of the <code>format</code> method in the various
 * <code>Format</code> classes requires a <code>FieldPosition</code>
 * object as an argument. You use this <code>format</code> method
 * to perform partial formatting or to get information about the
 * formatted output (such as the position of a field).
 *
 * The FieldPosition class is not intended for public subclassing.
 *
 * <p>
 * Below is an example of using <code>FieldPosition</code> to aid
 * alignment of an array of formatted floating-point numbers on
 * their decimal points:
 * <pre>
 * \code
 *       double doubleNum[] = {123456789.0, -12345678.9, 1234567.89, -123456.789,
 *                  12345.6789, -1234.56789, 123.456789, -12.3456789, 1.23456789};
 *       int dNumSize = (int)(sizeof(doubleNum)/sizeof(double));
 *       
 *       UErrorCode status = U_ZERO_ERROR;
 *       DecimalFormat* fmt = (DecimalFormat*) NumberFormat::createInstance(status);
 *       fmt->setDecimalSeparatorAlwaysShown(true);
 *       
 *       const int tempLen = 20;
 *       char temp[tempLen];
 *       
 *       for (int i=0; i<dNumSize; i++) {
 *           FieldPosition pos(NumberFormat::INTEGER_FIELD);
 *           UnicodeString buf;
 *           char fmtText[tempLen];
 *           ToCharString(fmt->format(doubleNum[i], buf, pos), fmtText);
 *           for (int j=0; j<tempLen; j++) temp[j] = ' '; // clear with spaces
 *           temp[__min(tempLen, tempLen-pos.getEndIndex())] = '\0';
 *           cout << temp << fmtText   << endl;
 *       }
 *       delete fmt;
 * \endcode
 * </pre>
 * <p>
 * The code will generate the following output:
 * <pre>
 * \code
 *           123,456,789.000
 *           -12,345,678.900
 *             1,234,567.880
 *              -123,456.789
 *                12,345.678
 *                -1,234.567
 *                   123.456
 *                   -12.345
 *                     1.234
 *  \endcode
 * </pre>
 */
class U_I18N_API FieldPosition : public UObject {
public:
    /**
     * DONT_CARE may be specified as the field to indicate that the
     * caller doesn't need to specify a field.
     * @stable ICU 2.0
     */
    enum { DONT_CARE = -1 };

    /**
     * Creates a FieldPosition object with a non-specified field.
     * @stable ICU 2.0
     */
    FieldPosition() 
        : UObject(), fField(DONT_CARE), fBeginIndex(0), fEndIndex(0) {}

    /**
     * Creates a FieldPosition object for the given field.  Fields are
     * identified by constants, whose names typically end with _FIELD,
     * in the various subclasses of Format.
     *
     * @see NumberFormat#INTEGER_FIELD
     * @see NumberFormat#FRACTION_FIELD
     * @see DateFormat#YEAR_FIELD
     * @see DateFormat#MONTH_FIELD
     * @stable ICU 2.0
     */
    FieldPosition(int32_t field) 
        : UObject(), fField(field), fBeginIndex(0), fEndIndex(0) {}

    /**
     * Copy constructor
     * @param copy the object to be copied from.
     * @stable ICU 2.0
     */
    FieldPosition(const FieldPosition& copy) 
        : UObject(copy), fField(copy.fField), fBeginIndex(copy.fBeginIndex), fEndIndex(copy.fEndIndex) {}

    /**
     * Destructor
     * @stable ICU 2.0
     */
    virtual ~FieldPosition();

    /**
     * Assignment operator
     * @param copy the object to be copied from.
     * @stable ICU 2.0
     */
    FieldPosition&      operator=(const FieldPosition& copy);

    /** 
     * Equality operator.
     * @param that    the object to be compared with.
     * @return        true if the two field positions are equal, false otherwise.
     * @stable ICU 2.0
     */
    bool               operator==(const FieldPosition& that) const;

    /** 
     * Equality operator.
     * @param that    the object to be compared with.
     * @return        true if the two field positions are not equal, false otherwise.
     * @stable ICU 2.0
     */
    bool               operator!=(const FieldPosition& that) const;

    /**
     * Clone this object.
     * Clones can be used concurrently in multiple threads.
     * If an error occurs, then nullptr is returned.
     * The caller must delete the clone.
     *
     * @return a clone of this object
     *
     * @see getDynamicClassID
     * @stable ICU 2.8
     */
    FieldPosition *clone() const;

    /**
     * Retrieve the field identifier.
     * @return    the field identifier.
     * @stable ICU 2.0
     */
    int32_t getField() const { return fField; }

    /**
     * Retrieve the index of the first character in the requested field.
     * @return    the index of the first character in the requested field.
     * @stable ICU 2.0
     */
    int32_t getBeginIndex() const { return fBeginIndex; }

    /**
     * Retrieve the index of the character following the last character in the
     * requested field.
     * @return    the index of the character following the last character in the
     *            requested field.
     * @stable ICU 2.0
     */
    int32_t getEndIndex() const { return fEndIndex; }

    /**
     * Set the field.
     * @param f    the new value of the field.
     * @stable ICU 2.0
     */
    void setField(int32_t f) { fField = f; }

    /**
     * Set the begin index.  For use by subclasses of Format.
     * @param bi    the new value of the begin index
     * @stable ICU 2.0
     */
    void setBeginIndex(int32_t bi) { fBeginIndex = bi; }

    /**
     * Set the end index.  For use by subclasses of Format.
     * @param ei    the new value of the end index
     * @stable ICU 2.0
     */
    void setEndIndex(int32_t ei) { fEndIndex = ei; }
    
    /**
     * ICU "poor man's RTTI", returns a UClassID for the actual class.
     *
     * @stable ICU 2.2
     */
    virtual UClassID getDynamicClassID() const override;

    /**
     * ICU "poor man's RTTI", returns a UClassID for this class.
     *
     * @stable ICU 2.2
     */
    static UClassID U_EXPORT2 getStaticClassID();

private:
    /**
     * Input: Desired field to determine start and end offsets for.
     * The meaning depends on the subclass of Format.
     */
    int32_t fField;

    /**
     * Output: Start offset of field in text.
     * If the field does not occur in the text, 0 is returned.
     */
    int32_t fBeginIndex;

    /**
     * Output: End offset of field in text.
     * If the field does not occur in the text, 0 is returned.
     */
    int32_t fEndIndex;
};

inline FieldPosition&
FieldPosition::operator=(const FieldPosition& copy)
{
    fField         = copy.fField;
    fEndIndex     = copy.fEndIndex;
    fBeginIndex = copy.fBeginIndex;
    return *this;
}

inline bool
FieldPosition::operator==(const FieldPosition& copy) const
{
    return (fField == copy.fField &&
        fEndIndex == copy.fEndIndex &&
        fBeginIndex == copy.fBeginIndex);
}

inline bool
FieldPosition::operator!=(const FieldPosition& copy) const
{
    return !operator==(copy);
}

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // _FIELDPOS
//eof
