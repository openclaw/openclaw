// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
**********************************************************************
*   Copyright (c) 2002-2005, International Business Machines Corporation
*   and others.  All Rights Reserved.
**********************************************************************
*   Date        Name        Description
*   01/14/2002  aliu        Creation.
**********************************************************************
*/
#ifndef UNIFUNCT_H
#define UNIFUNCT_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/uobject.h"

/**
 * \file 
 * \brief C++ API: Unicode Functor
 */
 
U_NAMESPACE_BEGIN

class UnicodeMatcher;
class UnicodeReplacer;
class TransliterationRuleData;

/**
 * <code>UnicodeFunctor</code> is an abstract base class for objects
 * that perform match and/or replace operations on Unicode strings.
 * @author Alan Liu
 * @stable ICU 2.4
 */
class U_COMMON_API UnicodeFunctor : public UObject {

public:

    /**
     * Destructor
     * @stable ICU 2.4
     */
    virtual ~UnicodeFunctor();

    /**
     * Return a copy of this object.  All UnicodeFunctor objects
     * have to support cloning in order to allow classes using
     * UnicodeFunctor to implement cloning.
     * @stable ICU 2.4
     */
    virtual UnicodeFunctor* clone() const = 0;

    /**
     * Cast 'this' to a UnicodeMatcher* pointer and return the
     * pointer, or null if this is not a UnicodeMatcher*.  Subclasses
     * that mix in UnicodeMatcher as a base class must override this.
     * This protocol is required because a pointer to a UnicodeFunctor
     * cannot be cast to a pointer to a UnicodeMatcher, since
     * UnicodeMatcher is a mixin that does not derive from
     * UnicodeFunctor.
     * @stable ICU 2.4
     */
    virtual UnicodeMatcher* toMatcher() const;

    /**
     * Cast 'this' to a UnicodeReplacer* pointer and return the
     * pointer, or null if this is not a UnicodeReplacer*.  Subclasses
     * that mix in UnicodeReplacer as a base class must override this.
     * This protocol is required because a pointer to a UnicodeFunctor
     * cannot be cast to a pointer to a UnicodeReplacer, since
     * UnicodeReplacer is a mixin that does not derive from
     * UnicodeFunctor.
     * @stable ICU 2.4
     */
    virtual UnicodeReplacer* toReplacer() const;

    /**
     * Return the class ID for this class.  This is useful only for
     * comparing to a return value from getDynamicClassID().
     * @return          The class ID for all objects of this class.
     * @stable ICU 2.0
     */
    static UClassID U_EXPORT2 getStaticClassID();

    /**
     * Returns a unique class ID <b>polymorphically</b>.  This method
     * is to implement a simple version of RTTI, since not all C++
     * compilers support genuine RTTI.  Polymorphic operator==() and
     * clone() methods call this method.
     *
     * <p>Concrete subclasses of UnicodeFunctor should use the macro
     *    UOBJECT_DEFINE_RTTI_IMPLEMENTATION from uobject.h to
     *    provide definitions getStaticClassID and getDynamicClassID.
     *
     * @return The class ID for this object. All objects of a given
     * class have the same class ID.  Objects of other classes have
     * different class IDs.
     * @stable ICU 2.4
     */
    virtual UClassID getDynamicClassID() const override = 0;

    /**
     * Set the data object associated with this functor.  The data
     * object provides context for functor-to-standin mapping.  This
     * method is required when assigning a functor to a different data
     * object.  This function MAY GO AWAY later if the architecture is
     * changed to pass data object pointers through the API.
     * @internal ICU 2.1
     */
    virtual void setData(const TransliterationRuleData*) = 0;

protected:

    /**
     * Since this class has pure virtual functions,
     * a constructor can't be used.
     * @stable ICU 2.0
     */
    /*UnicodeFunctor();*/

};

/*inline UnicodeFunctor::UnicodeFunctor() {}*/

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
