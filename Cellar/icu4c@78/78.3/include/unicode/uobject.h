// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
******************************************************************************
*
*   Copyright (C) 2002-2012, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
******************************************************************************
*   file name:  uobject.h
*   encoding:   UTF-8
*   tab size:   8 (not used)
*   indentation:4
*
*   created on: 2002jun26
*   created by: Markus W. Scherer
*/

#ifndef __UOBJECT_H__
#define __UOBJECT_H__

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/platform.h"

/**
 * \file
 * \brief C++ API: Common ICU base class UObject.
 */

/**
 * \def U_NO_THROW
 *         Since ICU 64, use noexcept instead.
 *
 *         Previously, define this to define the throw() specification so
 *                 certain functions do not throw any exceptions
 *
 *         UMemory operator new methods should have the throw() specification 
 *         appended to them, so that the compiler adds the additional nullptr check 
 *         before calling constructors. Without, if <code>operator new</code> returns nullptr the
 *         constructor is still called, and if the constructor references member 
 *         data, (which it typically does), the result is a segmentation violation.
 *
 * @stable ICU 4.2. Since ICU 64, Use noexcept instead. See ICU-20422.
 */
#ifndef U_NO_THROW
#define U_NO_THROW noexcept
#endif

/*===========================================================================*/
/* UClassID-based RTTI */
/*===========================================================================*/

/**
 * UClassID is used to identify classes without using the compiler's RTTI.
 * This was used before C++ compilers consistently supported RTTI.
 * ICU 4.6 requires compiler RTTI to be turned on.
 *
 * Each class hierarchy which needs
 * to implement polymorphic clone() or operator==() defines two methods,
 * described in detail below.  UClassID values can be compared using
 * operator==(). Nothing else should be done with them.
 *
 * \par
 * In class hierarchies that implement "poor man's RTTI",
 * each concrete subclass implements getDynamicClassID() in the same way:
 *
 * \code
 *      class Derived {
 *      public:
 *          virtual UClassID getDynamicClassID() const
 *            { return Derived::getStaticClassID(); }
 *      }
 * \endcode
 *
 * Each concrete class implements getStaticClassID() as well, which allows
 * clients to test for a specific type.
 *
 * \code
 *      class Derived {
 *      public:
 *          static UClassID U_EXPORT2 getStaticClassID();
 *      private:
 *          static char fgClassID;
 *      }
 *
 *      // In Derived.cpp:
 *      UClassID Derived::getStaticClassID()
 *        { return (UClassID)&Derived::fgClassID; }
 *      char Derived::fgClassID = 0; // Value is irrelevant
 * \endcode
 * @stable ICU 2.0
 */
typedef void* UClassID;

U_NAMESPACE_BEGIN

/**
 * UMemory is the common ICU base class.
 * All other ICU C++ classes are derived from UMemory (starting with ICU 2.4).
 *
 * This is primarily to make it possible and simple to override the
 * C++ memory management by adding new/delete operators to this base class.
 *
 * To override ALL ICU memory management, including that from plain C code,
 * replace the allocation functions declared in cmemory.h
 *
 * UMemory does not contain any virtual functions.
 * Common "boilerplate" functions are defined in UObject.
 *
 * @stable ICU 2.4
 */
class U_COMMON_API UMemory {
public:

/* test versions for debugging shaper heap memory problems */
#ifdef SHAPER_MEMORY_DEBUG  
    static void * NewArray(int size, int count);
    static void * GrowArray(void * array, int newSize );
    static void   FreeArray(void * array );
#endif

#if U_OVERRIDE_CXX_ALLOCATION
    /**
     * Override for ICU4C C++ memory management.
     * simple, non-class types are allocated using the macros in common/cmemory.h
     * (uprv_malloc(), uprv_free(), uprv_realloc());
     * they or something else could be used here to implement C++ new/delete
     * for ICU4C C++ classes
     * @stable ICU 2.4
     */
    static void * U_EXPORT2 operator new(size_t size) noexcept;

    /**
     * Override for ICU4C C++ memory management.
     * See new().
     * @stable ICU 2.4
     */
    static void * U_EXPORT2 operator new[](size_t size) noexcept;

    /**
     * Override for ICU4C C++ memory management.
     * simple, non-class types are allocated using the macros in common/cmemory.h
     * (uprv_malloc(), uprv_free(), uprv_realloc());
     * they or something else could be used here to implement C++ new/delete
     * for ICU4C C++ classes
     * @stable ICU 2.4
     */
    static void U_EXPORT2 operator delete(void *p) noexcept;

    /**
     * Override for ICU4C C++ memory management.
     * See delete().
     * @stable ICU 2.4
     */
    static void U_EXPORT2 operator delete[](void *p) noexcept;

    /**
     * Override for ICU4C C++ memory management for STL.
     * See new().
     * @stable ICU 2.6
     */
    static inline void * U_EXPORT2 operator new(size_t, void *ptr) noexcept { return ptr; }

    /**
     * Override for ICU4C C++ memory management for STL.
     * See delete().
     * @stable ICU 2.6
     */
    static inline void U_EXPORT2 operator delete(void *, void *) noexcept {}

#if U_HAVE_DEBUG_LOCATION_NEW
    /**
      * This method overrides the MFC debug version of the operator new
      * 
      * @param size   The requested memory size
      * @param file   The file where the allocation was requested
      * @param line   The line where the allocation was requested 
      */ 
    static void * U_EXPORT2 operator new(size_t size, const char* file, int line) noexcept;
    /**
      * This method provides a matching delete for the MFC debug new
      * 
      * @param p      The pointer to the allocated memory
      * @param file   The file where the allocation was requested
      * @param line   The line where the allocation was requested 
      */ 
    static void U_EXPORT2 operator delete(void* p, const char* file, int line) noexcept;
#endif /* U_HAVE_DEBUG_LOCATION_NEW */
#endif /* U_OVERRIDE_CXX_ALLOCATION */

    /*
     * Assignment operator not declared. The compiler will provide one
     * which does nothing since this class does not contain any data members.
     * API/code coverage may show the assignment operator as present and
     * untested - ignore.
     * Subclasses need this assignment operator if they use compiler-provided
     * assignment operators of their own. An alternative to not declaring one
     * here would be to declare and empty-implement a protected or public one.
    UMemory &UMemory::operator=(const UMemory &);
     */
};

/**
 * UObject is the common ICU "boilerplate" class.
 * UObject inherits UMemory (starting with ICU 2.4),
 * and all other public ICU C++ classes
 * are derived from UObject (starting with ICU 2.2).
 *
 * UObject contains common virtual functions, in particular a virtual destructor.
 *
 * The clone() function is not available in UObject because it is not
 * implemented by all ICU classes.
 * Many ICU services provide a clone() function for their class trees,
 * defined on the service's C++ base class
 * (which itself is a subclass of UObject).
 *
 * @stable ICU 2.2
 */
class U_COMMON_API UObject : public UMemory {
public:
    /**
     * Destructor.
     *
     * @stable ICU 2.2
     */
    virtual ~UObject();

    /**
     * ICU4C "poor man's RTTI", returns a UClassID for the actual ICU class.
     * The base class implementation returns a dummy value.
     *
     * Use compiler RTTI rather than ICU's "poor man's RTTI".
     * Since ICU 4.6, new ICU C++ class hierarchies do not implement "poor man's RTTI".
     *
     * @stable ICU 2.2
     */
    virtual UClassID getDynamicClassID() const;

protected:
    // the following functions are protected to prevent instantiation and
    // direct use of UObject itself

    // default constructor
    // inline UObject() {}

    // copy constructor
    // inline UObject(const UObject &other) {}

#if 0
    // TODO Sometime in the future. Implement operator==().
    // (This comment inserted in 2.2)
    // some or all of the following "boilerplate" functions may be made public
    // in a future ICU4C release when all subclasses implement them

    // assignment operator
    // (not virtual, see "Taligent's Guide to Designing Programs" pp.73..74)
    // commented out because the implementation is the same as a compiler's default
    // UObject &operator=(const UObject &other) { return *this; }

    // comparison operators
    virtual inline bool operator==(const UObject &other) const { return this==&other; }
    inline bool operator!=(const UObject &other) const { return !operator==(other); }

    // clone() commented out from the base class:
    // some compilers do not support co-variant return types
    // (i.e., subclasses would have to return UObject * as well, instead of SubClass *)
    // see also UObject class documentation.
    // virtual UObject *clone() const;
#endif

    /*
     * Assignment operator not declared. The compiler will provide one
     * which does nothing since this class does not contain any data members.
     * API/code coverage may show the assignment operator as present and
     * untested - ignore.
     * Subclasses need this assignment operator if they use compiler-provided
     * assignment operators of their own. An alternative to not declaring one
     * here would be to declare and empty-implement a protected or public one.
    UObject &UObject::operator=(const UObject &);
     */
};

#ifndef U_HIDE_INTERNAL_API
/**
 * This is a simple macro to add ICU RTTI to an ICU object implementation.
 * This does not go into the header. This should only be used in *.cpp files.
 *
 * @param myClass The name of the class that needs RTTI defined.
 * @internal
 */
#define UOBJECT_DEFINE_RTTI_IMPLEMENTATION(myClass) \
    UClassID U_EXPORT2 myClass::getStaticClassID() { \
        static char classID = 0; \
        return (UClassID)&classID; \
    } \
    UClassID myClass::getDynamicClassID() const \
    { return myClass::getStaticClassID(); }


/**
 * This macro adds ICU RTTI to an ICU abstract class implementation.
 * This macro should be invoked in *.cpp files.  The corresponding
 * header should declare getStaticClassID.
 *
 * @param myClass The name of the class that needs RTTI defined.
 * @internal
 */
#define UOBJECT_DEFINE_ABSTRACT_RTTI_IMPLEMENTATION(myClass) \
    UClassID U_EXPORT2 myClass::getStaticClassID() { \
        static char classID = 0; \
        return (UClassID)&classID; \
    }

#endif  /* U_HIDE_INTERNAL_API */

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
