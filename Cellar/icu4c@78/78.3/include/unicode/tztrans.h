// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
*******************************************************************************
* Copyright (C) 2007-2008, International Business Machines Corporation and         *
* others. All Rights Reserved.                                                *
*******************************************************************************
*/
#ifndef TZTRANS_H
#define TZTRANS_H

/**
 * \file 
 * \brief C++ API: Time zone transition
 */

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_FORMATTING

#include "unicode/uobject.h"

U_NAMESPACE_BEGIN

// Forward declaration
class TimeZoneRule;

/**
 * <code>TimeZoneTransition</code> is a class representing a time zone transition.
 * An instance has a time of transition and rules for both before and after the transition.
 * @stable ICU 3.8
 */
class U_I18N_API TimeZoneTransition : public UObject {
public:
    /**
     * Constructs a <code>TimeZoneTransition</code> with the time and the rules before/after
     * the transition.
     * 
     * @param time  The time of transition in milliseconds since the base time.
     * @param from  The time zone rule used before the transition.
     * @param to    The time zone rule used after the transition.
     * @stable ICU 3.8
     */
    TimeZoneTransition(UDate time, const TimeZoneRule& from, const TimeZoneRule& to);

    /**
     * Constructs an empty <code>TimeZoneTransition</code>
     * @stable ICU 3.8
     */
    TimeZoneTransition();

    /**
     * Copy constructor.
     * @param source    The TimeZoneTransition object to be copied.
     * @stable ICU 3.8
     */
    TimeZoneTransition(const TimeZoneTransition& source);

    /**
     * Destructor.
     * @stable ICU 3.8
     */
    ~TimeZoneTransition();

    /**
     * Clone this TimeZoneTransition object polymorphically. The caller owns the result and
     * should delete it when done.
     * @return  A copy of the object.
     * @stable ICU 3.8
     */
    TimeZoneTransition* clone() const;

    /**
     * Assignment operator.
     * @param right The object to be copied.
     * @stable ICU 3.8
     */
    TimeZoneTransition& operator=(const TimeZoneTransition& right);

    /**
     * Return true if the given TimeZoneTransition objects are semantically equal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given TimeZoneTransition objects are semantically equal.
     * @stable ICU 3.8
     */
    bool operator==(const TimeZoneTransition& that) const;

    /**
     * Return true if the given TimeZoneTransition objects are semantically unequal. Objects
     * of different subclasses are considered unequal.
     * @param that  The object to be compared with.
     * @return  true if the given TimeZoneTransition objects are semantically unequal.
     * @stable ICU 3.8
     */
    bool operator!=(const TimeZoneTransition& that) const;

    /**
     * Returns the time of transition in milliseconds.
     * @return The time of the transition in milliseconds since the 1970 Jan 1 epoch time.
     * @stable ICU 3.8
     */
    UDate getTime() const;

    /**
     * Sets the time of transition in milliseconds.
     * @param time The time of the transition in milliseconds since the 1970 Jan 1 epoch time.
     * @stable ICU 3.8
     */
    void setTime(UDate time);

    /**
     * Returns the rule used before the transition.
     * @return The time zone rule used after the transition.
     * @stable ICU 3.8
     */
    const TimeZoneRule* getFrom() const;

    /**
     * Sets the rule used before the transition.  The caller remains
     * responsible for deleting the <code>TimeZoneRule</code> object.
     * @param from The time zone rule used before the transition.
     * @stable ICU 3.8
     */
    void setFrom(const TimeZoneRule& from);

    /**
     * Adopts the rule used before the transition.  The caller must
     * not delete the <code>TimeZoneRule</code> object passed in.
     * @param from The time zone rule used before the transition.
     * @stable ICU 3.8
     */
    void adoptFrom(TimeZoneRule* from);

    /**
     * Sets the rule used after the transition.  The caller remains
     * responsible for deleting the <code>TimeZoneRule</code> object.
     * @param to The time zone rule used after the transition.
     * @stable ICU 3.8
     */
    void setTo(const TimeZoneRule& to);

    /**
     * Adopts the rule used after the transition.  The caller must
     * not delete the <code>TimeZoneRule</code> object passed in.
     * @param to The time zone rule used after the transition.
     * @stable ICU 3.8
     */
    void adoptTo(TimeZoneRule* to);

    /**
     * Returns the rule used after the transition.
     * @return The time zone rule used after the transition.
     * @stable ICU 3.8
     */
    const TimeZoneRule* getTo() const;

private:
    UDate   fTime;
    TimeZoneRule*   fFrom;
    TimeZoneRule*   fTo;

public:
    /**
     * Return the class ID for this class. This is useful only for comparing to
     * a return value from getDynamicClassID(). For example:
     * <pre>
     * .   Base* polymorphic_pointer = createPolymorphicObject();
     * .   if (polymorphic_pointer->getDynamicClassID() ==
     * .       erived::getStaticClassID()) ...
     * </pre>
     * @return          The class ID for all objects of this class.
     * @stable ICU 3.8
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
     * @stable ICU 3.8
     */
    virtual UClassID getDynamicClassID() const override;
};

U_NAMESPACE_END

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // TZTRANS_H

//eof
