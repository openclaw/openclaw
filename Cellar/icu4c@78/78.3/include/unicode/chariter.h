// © 2016 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html
/*
********************************************************************
*
*   Copyright (C) 1997-2011, International Business Machines
*   Corporation and others.  All Rights Reserved.
*
********************************************************************
*/

#ifndef CHARITER_H
#define CHARITER_H

#include "unicode/utypes.h"

#if U_SHOW_CPLUSPLUS_API

#include "unicode/uobject.h"
#include "unicode/unistr.h"
/**
 * \file
 * \brief C++ API: Character Iterator
 */
 
U_NAMESPACE_BEGIN
/**
 * Abstract class that defines an API for forward-only iteration
 * on text objects.
 * This is a minimal interface for iteration without random access
 * or backwards iteration. It is especially useful for wrapping
 * streams with converters into an object for collation or
 * normalization.
 *
 * <p>Characters can be accessed in two ways: as code units or as
 * code points.
 * Unicode code points are 21-bit integers and are the scalar values
 * of Unicode characters. ICU uses the type UChar32 for them.
 * Unicode code units are the storage units of a given
 * Unicode/UCS Transformation Format (a character encoding scheme).
 * With UTF-16, all code points can be represented with either one
 * or two code units ("surrogates").
 * String storage is typically based on code units, while properties
 * of characters are typically determined using code point values.
 * Some processes may be designed to work with sequences of code units,
 * or it may be known that all characters that are important to an
 * algorithm can be represented with single code units.
 * Other processes will need to use the code point access functions.</p>
 *
 * <p>ForwardCharacterIterator provides nextPostInc() to access
 * a code unit and advance an internal position into the text object,
 * similar to a <code>return text[position++]</code>.<br>
 * It provides next32PostInc() to access a code point and advance an internal
 * position.</p>
 *
 * <p>next32PostInc() assumes that the current position is that of
 * the beginning of a code point, i.e., of its first code unit.
 * After next32PostInc(), this will be true again.
 * In general, access to code units and code points in the same
 * iteration loop should not be mixed. In UTF-16, if the current position
 * is on a second code unit (Low Surrogate), then only that code unit
 * is returned even by next32PostInc().</p>
 *
 * <p>For iteration with either function, there are two ways to
 * check for the end of the iteration. When there are no more
 * characters in the text object:
 * <ul>
 * <li>The hasNext() function returns false.</li>
 * <li>nextPostInc() and next32PostInc() return DONE
 *     when one attempts to read beyond the end of the text object.</li>
 * </ul>
 *
 * Example:
 * \code 
 * void function1(ForwardCharacterIterator &it) {
 *     UChar32 c;
 *     while(it.hasNext()) {
 *         c=it.next32PostInc();
 *         // use c
 *     }
 * }
 *
 * void function1(ForwardCharacterIterator &it) {
 *     char16_t c;
 *     while((c=it.nextPostInc())!=ForwardCharacterIterator::DONE) {
 *         // use c
 *      }
 *  }
 * \endcode
 * </p>
 *
 * @stable ICU 2.0
 */
class U_COMMON_API ForwardCharacterIterator : public UObject {
public:
    /**
     * Value returned by most of ForwardCharacterIterator's functions
     * when the iterator has reached the limits of its iteration.
     * @stable ICU 2.0
     */
    enum { DONE = 0xffff };
    
    /**
     * Destructor.  
     * @stable ICU 2.0
     */
    virtual ~ForwardCharacterIterator();
    
    /**
     * Returns true when both iterators refer to the same
     * character in the same character-storage object.  
     * @param that The ForwardCharacterIterator to be compared for equality
     * @return true when both iterators refer to the same
     * character in the same character-storage object
     * @stable ICU 2.0
     */
    virtual bool operator==(const ForwardCharacterIterator& that) const = 0;
    
    /**
     * Returns true when the iterators refer to different
     * text-storage objects, or to different characters in the
     * same text-storage object.  
     * @param that The ForwardCharacterIterator to be compared for inequality
     * @return true when the iterators refer to different
     * text-storage objects, or to different characters in the
     * same text-storage object
     * @stable ICU 2.0
     */
    inline bool operator!=(const ForwardCharacterIterator& that) const;
    
    /**
     * Generates a hash code for this iterator.  
     * @return the hash code.
     * @stable ICU 2.0
     */
    virtual int32_t hashCode() const = 0;

    /**
     * Returns a UClassID for this ForwardCharacterIterator ("poor man's
     * RTTI").<P> Despite the fact that this function is public,
     * DO NOT CONSIDER IT PART OF CHARACTERITERATOR'S API! 
     * @return a UClassID for this ForwardCharacterIterator 
     * @stable ICU 2.0
     */
    virtual UClassID getDynamicClassID() const override = 0;

    /**
     * Gets the current code unit for returning and advances to the next code unit
     * in the iteration range
     * (toward endIndex()).  If there are
     * no more code units to return, returns DONE.
     * @return the current code unit.
     * @stable ICU 2.0
     */
    virtual char16_t nextPostInc() = 0;

    /**
     * Gets the current code point for returning and advances to the next code point
     * in the iteration range
     * (toward endIndex()).  If there are
     * no more code points to return, returns DONE.
     * @return the current code point.
     * @stable ICU 2.0
     */
    virtual UChar32 next32PostInc() = 0;

    /**
     * Returns false if there are no more code units or code points
     * at or after the current position in the iteration range.
     * This is used with nextPostInc() or next32PostInc() in forward
     * iteration.
     * @returns false if there are no more code units or code points
     * at or after the current position in the iteration range.
     * @stable ICU 2.0
     */
    virtual UBool        hasNext() = 0;
    
protected:
    /** Default constructor to be overridden in the implementing class. @stable ICU 2.0*/
    ForwardCharacterIterator();
    
    /** Copy constructor to be overridden in the implementing class. @stable ICU 2.0*/
    ForwardCharacterIterator(const ForwardCharacterIterator &other);
    
    /**
     * Assignment operator to be overridden in the implementing class.
     * @stable ICU 2.0
     */
    ForwardCharacterIterator &operator=(const ForwardCharacterIterator&) { return *this; }
};

/**
 * Abstract class that defines an API for iteration
 * on text objects.
 * This is an interface for forward and backward iteration
 * and random access into a text object.
 *
 * <p>The API provides backward compatibility to the Java and older ICU
 * CharacterIterator classes but extends them significantly:
 * <ol>
 * <li>CharacterIterator is now a subclass of ForwardCharacterIterator.</li>
 * <li>While the old API functions provided forward iteration with
 *     "pre-increment" semantics, the new one also provides functions
 *     with "post-increment" semantics. They are more efficient and should
 *     be the preferred iterator functions for new implementations.
 *     The backward iteration always had "pre-decrement" semantics, which
 *     are efficient.</li>
 * <li>Just like ForwardCharacterIterator, it provides access to
 *     both code units and code points. Code point access versions are available
 *     for the old and the new iteration semantics.</li>
 * <li>There are new functions for setting and moving the current position
 *     without returning a character, for efficiency.</li>
 * </ol>
 *
 * See ForwardCharacterIterator for examples for using the new forward iteration
 * functions. For backward iteration, there is also a hasPrevious() function
 * that can be used analogously to hasNext().
 * The old functions work as before and are shown below.</p>
 *
 * <p>Examples for some of the new functions:</p>
 *
 * Forward iteration with hasNext():
 * \code
 * void forward1(CharacterIterator &it) {
 *     UChar32 c;
 *     for(it.setToStart(); it.hasNext();) {
 *         c=it.next32PostInc();
 *         // use c
 *     }
 *  }
 * \endcode
 * Forward iteration more similar to loops with the old forward iteration,
 * showing a way to convert simple for() loops:
 * \code
 * void forward2(CharacterIterator &it) {
 *     char16_t c;
 *     for(c=it.firstPostInc(); c!=CharacterIterator::DONE; c=it.nextPostInc()) {
 *          // use c
 *      }
 * }
 * \endcode
 * Backward iteration with setToEnd() and hasPrevious():
 * \code
 *  void backward1(CharacterIterator &it) {
 *      UChar32 c;
 *      for(it.setToEnd(); it.hasPrevious();) {
 *         c=it.previous32();
 *          // use c
 *      }
 *  }
 * \endcode
 * Backward iteration with a more traditional for() loop:
 * \code
 * void backward2(CharacterIterator &it) {
 *     char16_t c;
 *     for(c=it.last(); c!=CharacterIterator::DONE; c=it.previous()) {
 *         // use c
 *      }
 *  }
 * \endcode
 *
 * Example for random access:
 * \code
 *  void random(CharacterIterator &it) {
 *      // set to the third code point from the beginning
 *      it.move32(3, CharacterIterator::kStart);
 *      // get a code point from here without moving the position
 *      UChar32 c=it.current32();
 *      // get the position
 *      int32_t pos=it.getIndex();
 *      // get the previous code unit
 *      char16_t u=it.previous();
 *      // move back one more code unit
 *      it.move(-1, CharacterIterator::kCurrent);
 *      // set the position back to where it was
 *      // and read the same code point c and move beyond it
 *      it.setIndex(pos);
 *      if(c!=it.next32PostInc()) {
 *          exit(1); // CharacterIterator inconsistent
 *      }
 *  }
 * \endcode
 *
 * <p>Examples, especially for the old API:</p>
 *
 * Function processing characters, in this example simple output
 * <pre>
 * \code
 *  void processChar( char16_t c )
 *  {
 *      cout << " " << c;
 *  }
 * \endcode
 * </pre>
 * Traverse the text from start to finish
 * <pre> 
 * \code
 *  void traverseForward(CharacterIterator& iter)
 *  {
 *      for(char16_t c = iter.first(); c != CharacterIterator::DONE; c = iter.next()) {
 *          processChar(c);
 *      }
 *  }
 * \endcode
 * </pre>
 * Traverse the text backwards, from end to start
 * <pre>
 * \code
 *  void traverseBackward(CharacterIterator& iter)
 *  {
 *      for(char16_t c = iter.last(); c != CharacterIterator::DONE; c = iter.previous()) {
 *          processChar(c);
 *      }
 *  }
 * \endcode
 * </pre>
 * Traverse both forward and backward from a given position in the text. 
 * Calls to notBoundary() in this example represents some additional stopping criteria.
 * <pre>
 * \code
 * void traverseOut(CharacterIterator& iter, int32_t pos)
 * {
 *      char16_t c;
 *      for (c = iter.setIndex(pos);
 *      c != CharacterIterator::DONE && (Unicode::isLetter(c) || Unicode::isDigit(c));
 *          c = iter.next()) {}
 *      int32_t end = iter.getIndex();
 *      for (c = iter.setIndex(pos);
 *          c != CharacterIterator::DONE && (Unicode::isLetter(c) || Unicode::isDigit(c));
 *          c = iter.previous()) {}
 *      int32_t start = iter.getIndex() + 1;
 *  
 *      cout << "start: " << start << " end: " << end << endl;
 *      for (c = iter.setIndex(start); iter.getIndex() < end; c = iter.next() ) {
 *          processChar(c);
 *     }
 *  }
 * \endcode
 * </pre>
 * Creating a StringCharacterIterator and calling the test functions
 * <pre>
 * \code
 *  void CharacterIterator_Example( void )
 *   {
 *       cout << endl << "===== CharacterIterator_Example: =====" << endl;
 *       UnicodeString text("Ein kleiner Satz.");
 *       StringCharacterIterator iterator(text);
 *       cout << "----- traverseForward: -----------" << endl;
 *       traverseForward( iterator );
 *       cout << endl << endl << "----- traverseBackward: ----------" << endl;
 *       traverseBackward( iterator );
 *       cout << endl << endl << "----- traverseOut: ---------------" << endl;
 *       traverseOut( iterator, 7 );
 *       cout << endl << endl << "-----" << endl;
 *   }
 * \endcode
 * </pre>
 *
 * @stable ICU 2.0
 */
class U_COMMON_API CharacterIterator : public ForwardCharacterIterator {
public:
    /**
     * Origin enumeration for the move() and move32() functions.
     * @stable ICU 2.0
     */
    enum EOrigin { kStart, kCurrent, kEnd };

    /**
     * Destructor.
     * @stable ICU 2.0
     */
    virtual ~CharacterIterator();

    /**
     * Returns a pointer to a new CharacterIterator of the same
     * concrete class as this one, and referring to the same
     * character in the same text-storage object as this one.  The
     * caller is responsible for deleting the new clone.  
     * @return a pointer to a new CharacterIterator
     * @stable ICU 2.0
     */
    virtual CharacterIterator* clone() const = 0;

    /**
     * Sets the iterator to refer to the first code unit in its
     * iteration range, and returns that code unit.
     * This can be used to begin an iteration with next().
     * @return the first code unit in its iteration range.
     * @stable ICU 2.0
     */
    virtual char16_t first() = 0;

    /**
     * Sets the iterator to refer to the first code unit in its
     * iteration range, returns that code unit, and moves the position
     * to the second code unit. This is an alternative to setToStart()
     * for forward iteration with nextPostInc().
     * @return the first code unit in its iteration range.
     * @stable ICU 2.0
     */
    virtual char16_t firstPostInc();

    /**
     * Sets the iterator to refer to the first code point in its
     * iteration range, and returns that code unit,
     * This can be used to begin an iteration with next32().
     * Note that an iteration with next32PostInc(), beginning with,
     * e.g., setToStart() or firstPostInc(), is more efficient.
     * @return the first code point in its iteration range.
     * @stable ICU 2.0
     */
    virtual UChar32 first32() = 0;

    /**
     * Sets the iterator to refer to the first code point in its
     * iteration range, returns that code point, and moves the position
     * to the second code point. This is an alternative to setToStart()
     * for forward iteration with next32PostInc().
     * @return the first code point in its iteration range.
     * @stable ICU 2.0
     */
    virtual UChar32 first32PostInc();

    /**
     * Sets the iterator to refer to the first code unit or code point in its
     * iteration range. This can be used to begin a forward
     * iteration with nextPostInc() or next32PostInc().
     * @return the start position of the iteration range
     * @stable ICU 2.0
     */
    inline int32_t    setToStart();

    /**
     * Sets the iterator to refer to the last code unit in its
     * iteration range, and returns that code unit.
     * This can be used to begin an iteration with previous().
     * @return the last code unit.
     * @stable ICU 2.0
     */
    virtual char16_t last() = 0;

    /**
     * Sets the iterator to refer to the last code point in its
     * iteration range, and returns that code unit.
     * This can be used to begin an iteration with previous32().
     * @return the last code point.
     * @stable ICU 2.0
     */
    virtual UChar32 last32() = 0;

    /**
     * Sets the iterator to the end of its iteration range, just behind
     * the last code unit or code point. This can be used to begin a backward
     * iteration with previous() or previous32().
     * @return the end position of the iteration range
     * @stable ICU 2.0
     */
    inline int32_t    setToEnd();

    /**
     * Sets the iterator to refer to the "position"-th code unit
     * in the text-storage object the iterator refers to, and
     * returns that code unit.  
     * @param position the "position"-th code unit in the text-storage object
     * @return the "position"-th code unit.
     * @stable ICU 2.0
     */
    virtual char16_t         setIndex(int32_t position) = 0;

    /**
     * Sets the iterator to refer to the beginning of the code point
     * that contains the "position"-th code unit
     * in the text-storage object the iterator refers to, and
     * returns that code point.
     * The current position is adjusted to the beginning of the code point
     * (its first code unit).
     * @param position the "position"-th code unit in the text-storage object
     * @return the "position"-th code point.
     * @stable ICU 2.0
     */
    virtual UChar32       setIndex32(int32_t position) = 0;

    /**
     * Returns the code unit the iterator currently refers to. 
     * @return the current code unit. 
     * @stable ICU 2.0
     */
    virtual char16_t current() const = 0;

    /**
     * Returns the code point the iterator currently refers to.  
     * @return the current code point.
     * @stable ICU 2.0
     */
    virtual UChar32 current32() const = 0;

    /**
     * Advances to the next code unit in the iteration range
     * (toward endIndex()), and returns that code unit.  If there are
     * no more code units to return, returns DONE.
     * @return the next code unit.
     * @stable ICU 2.0
     */
    virtual char16_t next() = 0;

    /**
     * Advances to the next code point in the iteration range
     * (toward endIndex()), and returns that code point.  If there are
     * no more code points to return, returns DONE.
     * Note that iteration with "pre-increment" semantics is less
     * efficient than iteration with "post-increment" semantics
     * that is provided by next32PostInc().
     * @return the next code point.
     * @stable ICU 2.0
     */
    virtual UChar32 next32() = 0;

    /**
     * Advances to the previous code unit in the iteration range
     * (toward startIndex()), and returns that code unit.  If there are
     * no more code units to return, returns DONE.  
     * @return the previous code unit.
     * @stable ICU 2.0
     */
    virtual char16_t previous() = 0;

    /**
     * Advances to the previous code point in the iteration range
     * (toward startIndex()), and returns that code point.  If there are
     * no more code points to return, returns DONE. 
     * @return the previous code point. 
     * @stable ICU 2.0
     */
    virtual UChar32 previous32() = 0;

    /**
     * Returns false if there are no more code units or code points
     * before the current position in the iteration range.
     * This is used with previous() or previous32() in backward
     * iteration.
     * @return false if there are no more code units or code points
     * before the current position in the iteration range, return true otherwise.
     * @stable ICU 2.0
     */
    virtual UBool        hasPrevious() = 0;

    /**
     * Returns the numeric index in the underlying text-storage
     * object of the character returned by first().  Since it's
     * possible to create an iterator that iterates across only
     * part of a text-storage object, this number isn't
     * necessarily 0.  
     * @returns the numeric index in the underlying text-storage
     * object of the character returned by first().
     * @stable ICU 2.0
     */
    inline int32_t startIndex() const;

    /**
     * Returns the numeric index in the underlying text-storage
     * object of the position immediately BEYOND the character
     * returned by last().  
     * @return the numeric index in the underlying text-storage
     * object of the position immediately BEYOND the character
     * returned by last().
     * @stable ICU 2.0
     */
    inline int32_t endIndex() const;

    /**
     * Returns the numeric index in the underlying text-storage
     * object of the character the iterator currently refers to
     * (i.e., the character returned by current()).  
     * @return the numeric index in the text-storage object of 
     * the character the iterator currently refers to
     * @stable ICU 2.0
     */
    inline int32_t getIndex() const;

    /**
     * Returns the length of the entire text in the underlying
     * text-storage object.
     * @return the length of the entire text in the text-storage object
     * @stable ICU 2.0
     */
    inline int32_t           getLength() const;

    /**
     * Moves the current position relative to the start or end of the
     * iteration range, or relative to the current position itself.
     * The movement is expressed in numbers of code units forward
     * or backward by specifying a positive or negative delta.
     * @param delta the position relative to origin. A positive delta means forward;
     * a negative delta means backward.
     * @param origin Origin enumeration {kStart, kCurrent, kEnd}
     * @return the new position
     * @stable ICU 2.0
     */
    virtual int32_t      move(int32_t delta, EOrigin origin) = 0;

    /**
     * Moves the current position relative to the start or end of the
     * iteration range, or relative to the current position itself.
     * The movement is expressed in numbers of code points forward
     * or backward by specifying a positive or negative delta.
     * @param delta the position relative to origin. A positive delta means forward;
     * a negative delta means backward.
     * @param origin Origin enumeration {kStart, kCurrent, kEnd}
     * @return the new position
     * @stable ICU 2.0
     */
#ifdef move32
     // One of the system headers right now is sometimes defining a conflicting macro we don't use
#undef move32
#endif
    virtual int32_t      move32(int32_t delta, EOrigin origin) = 0;

    /**
     * Copies the text under iteration into the UnicodeString
     * referred to by "result".  
     * @param result Receives a copy of the text under iteration.  
     * @stable ICU 2.0
     */
    virtual void            getText(UnicodeString&  result) = 0;

protected:
    /**
     * Empty constructor.
     * @stable ICU 2.0
     */
    CharacterIterator();

    /**
     * Constructor, just setting the length field in this base class.
     * @stable ICU 2.0
     */
    CharacterIterator(int32_t length);

    /**
     * Constructor, just setting the length and position fields in this base class.
     * @stable ICU 2.0
     */
    CharacterIterator(int32_t length, int32_t position);

    /**
     * Constructor, just setting the length, start, end, and position fields in this base class.
     * @stable ICU 2.0
     */
    CharacterIterator(int32_t length, int32_t textBegin, int32_t textEnd, int32_t position);
  
    /**
     * Copy constructor.
     *
     * @param that The CharacterIterator to be copied
     * @stable ICU 2.0
     */
    CharacterIterator(const CharacterIterator &that);

    /**
     * Assignment operator.  Sets this CharacterIterator to have the same behavior,
     * as the one passed in.
     * @param that The CharacterIterator passed in.
     * @return the newly set CharacterIterator.
     * @stable ICU 2.0
     */
    CharacterIterator &operator=(const CharacterIterator &that);

    /**
     * Base class text length field.
     * Necessary this for correct getText() and hashCode().
     * @stable ICU 2.0
     */
    int32_t textLength;

    /**
     * Base class field for the current position.
     * @stable ICU 2.0
     */
    int32_t  pos;

    /**
     * Base class field for the start of the iteration range.
     * @stable ICU 2.0
     */
    int32_t  begin;

    /**
     * Base class field for the end of the iteration range.
     * @stable ICU 2.0
     */
    int32_t  end;
};

inline bool
ForwardCharacterIterator::operator!=(const ForwardCharacterIterator& that) const {
    return !operator==(that);
}

inline int32_t
CharacterIterator::setToStart() {
    return move(0, kStart);
}

inline int32_t
CharacterIterator::setToEnd() {
    return move(0, kEnd);
}

inline int32_t
CharacterIterator::startIndex() const {
    return begin;
}

inline int32_t
CharacterIterator::endIndex() const {
    return end;
}

inline int32_t
CharacterIterator::getIndex() const {
    return pos;
}

inline int32_t
CharacterIterator::getLength() const {
    return textLength;
}

U_NAMESPACE_END

#endif /* U_SHOW_CPLUSPLUS_API */

#endif
