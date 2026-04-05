// © 2024 and later: Unicode, Inc. and others.
// License & terms of use: http://www.unicode.org/copyright.html

#include "unicode/utypes.h"

#ifndef MESSAGEFORMAT_DATA_MODEL_H
#define MESSAGEFORMAT_DATA_MODEL_H

#if U_SHOW_CPLUSPLUS_API

#if !UCONFIG_NO_NORMALIZATION

#if !UCONFIG_NO_FORMATTING

#if !UCONFIG_NO_MF2

#include "unicode/localpointer.h"
#include "unicode/messageformat2_data_model_names.h"

#ifndef U_HIDE_DEPRECATED_API

#include <algorithm>
#include <cstddef>
#include <iterator>
#include <optional>
#include <variant>
#include <vector>

U_NAMESPACE_BEGIN

class UVector;

// Helpers

// Note: this _must_ be declared `inline` or else gcc will generate code
// for its instantiations, which needs to be avoided because it returns
// a std::vector
template<typename T>
static inline std::vector<T> toStdVector(const T* arr, int32_t len) {
    std::vector<T> result;
    for (int32_t i = 0; i < len; i++) {
        result.push_back(arr[i]);
    }
    return result;
}

#if defined(U_REAL_MSVC)
#pragma warning(push)
// Ignore warning 4251 as these templates are instantiated later in this file,
// after the classes used to instantiate them have been defined.
#pragma warning(disable: 4251)
#endif

namespace message2 {
    class Checker;
    class MessageFormatter;
    class Parser;
    class Serializer;


  namespace data_model {
        class Binding;
        class Literal;
        class Operator;
        class MFDataModel;

      /**
         * The `Literal` class corresponds to the `literal` nonterminal in the MessageFormat 2 grammar,
         * https://github.com/unicode-org/message-format-wg/blob/main/spec/message.abnf and the
         * `Literal` interface defined in
         *   // https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#expressions
         *
         * `Literal` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Literal : public UObject {
        public:
            /**
             * Returns the quoted representation of this literal (enclosed in '|' characters)
             *
             * @return A string representation of the literal enclosed in quote characters.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            UnicodeString quoted() const;
            /**
             * Returns the parsed string contents of this literal.
             *
             * @return A string representation of this literal.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const UnicodeString& unquoted() const;
            /**
             * Determines if this literal appeared as a quoted literal in the message.
             *
             * @return true if and only if this literal appeared as a quoted literal in the
             *         message.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            UBool isQuoted() const { return thisIsQuoted; }
            /**
             * Literal constructor.
             *
             *  @param q True if and only if this literal was parsed with the `quoted` nonterminal
             *           (appeared enclosed in '|' characters in the message text).
             *  @param s The string contents of this literal; escape sequences are assumed to have
             *           been interpreted already.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Literal(UBool q, const UnicodeString& s) : thisIsQuoted(q), contents(s) {}
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Literal(const Literal& other) : thisIsQuoted(other.thisIsQuoted), contents(other.contents) {}
            /**
             * Non-member swap function.
             * @param l1 will get l2's contents
             * @param l2 will get l1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            friend inline void swap(Literal& l1, Literal& l2) noexcept {
                using std::swap;

                swap(l1.thisIsQuoted, l2.thisIsQuoted);
                swap(l1.contents, l2.contents);
            }
            /**
             * Assignment operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Literal& operator=(Literal) noexcept;
            /**
             * Default constructor.
             * Puts the Literal into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Literal() = default;
            /**
             * Less than operator. Compares `this.stringContents()` with
             * `other.stringContents()`. This method is used in representing
             * the mapping from key lists to patterns in a message with variants,
             * and is not expected to be useful otherwise.
             *
             * @param other The Literal to compare to this one.
             * @return true if the parsed string corresponding to this `Literal`
             * is less than the parsed string corresponding to the other `Literal`
             * (according to `UnicodeString`'s less-than operator).
             * Returns false otherwise.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            bool operator<(const Literal& other) const;
            /**
             * Equality operator. Compares `this.stringContents()` with
             * `other.stringContents()`. This method is used in representing
             * the mapping from key lists to patterns in a message with variants,
             * and is not expected to be useful otherwise.
             *
             * @param other The Literal to compare to this one.
             * @return true if the parsed string corresponding to this `Literal`
             * equals the parsed string corresponding to the other `Literal`
             * (according to `UnicodeString`'s equality operator).
             * Returns false otherwise.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            bool operator==(const Literal& other) const;
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Literal();

        private:
            /* const */ bool thisIsQuoted = false;
            /* const */ UnicodeString contents;
        };

        /**
         * The `Operand` class corresponds to the `operand` nonterminal in the MessageFormat 2 grammar,
         * https://github.com/unicode-org/message-format-wg/blob/main/spec/message.abnf .
         * It represents a `Literal | VariableRef` -- see the `operand?` field of the `FunctionRef`
         * interface defined at:
         * https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#expressions
         * with the difference that it can also represent a null operand (the absent operand in an
         * `annotation` with no operand).
         *
         * `Operand` is immutable and is copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API_CLASS Operand : public UObject {
        public:
            /**
             * Determines if this operand represents a variable.
             *
             * @return True if and only if the operand is a variable.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isVariable() const;
            /**
             * Determines if this operand represents a literal.
             *
             * @return True if and only if the operand is a literal.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isLiteral() const;
            /**
             * Determines if this operand is the null operand.
             *
             * @return True if and only if the operand is the null operand.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual UBool isNull() const;
            /**
             * Returns a reference to this operand's variable name.
             * Precondition: isVariable()
             *
             * @return A reference to the name of the variable
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const UnicodeString& asVariable() const;
            /**
             * Returns a reference to this operand's literal contents.
             * Precondition: isLiteral()
             *
             * @return A reference to the literal
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const Literal& asLiteral() const;
            /**
             * Default constructor.
             * Creates a null Operand.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Operand() : contents(std::nullopt) {}
            /**
             * Variable operand constructor.
             *
             * @param v The variable name; an operand corresponding
             *        to a reference to `v` is returned.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API explicit Operand(const UnicodeString& v) : contents(VariableName(v)) {}
            /**
             * Literal operand constructor.
             *
             * @param l The literal to use for this operand; an operand
             *        corresponding to `l` is returned.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API explicit Operand(const Literal& l) : contents(l) {}
            /**
             * Non-member swap function.
             * @param o1 will get o2's contents
             * @param o2 will get o1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API friend inline void swap(Operand& o1, Operand& o2) noexcept {
                using std::swap;
                (void) o1;
                (void) o2;
                swap(o1.contents, o2.contents);
            }
            /**
             * Assignment operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual Operand& operator=(Operand) noexcept;
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Operand(const Operand&);
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual ~Operand();
        private:
            std::optional<std::variant<VariableName, Literal>> contents;
        }; // class Operand

        /**
         * The `Key` class corresponds to the `key` nonterminal in the MessageFormat 2 grammar,
         * https://github.com/unicode-org/message-format-wg/blob/main/spec/message.abnf .
         * It also corresponds to
         * the `Literal | CatchallKey` that is the
         * element type of the `keys` array in the `Variant` interface
         * defined in https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#messages
         *
         * A key is either a literal or the wildcard symbol (represented in messages as '*')
         *
         * `Key` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API_CLASS Key : public UObject {
        public:
            /**
             * Determines if this is a wildcard key
             *
             * @return True if and only if this is the wildcard key
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isWildcard() const { return !contents.has_value(); }
            /**
             * Returns the contents of this key as a literal.
             * Precondition: !isWildcard()
             *
             * @return The literal contents of the key
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const Literal& asLiteral() const;
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Key(const Key& other) : contents(other.contents) {}
            /**
             * Wildcard constructor; constructs a Key representing the
             * catchall or wildcard key, '*'.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Key() : contents(std::nullopt) {}
            /**
             * Literal key constructor.
             *
             * @param lit A Literal to use for this key. The result matches the
             *        literal `lit`.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API explicit Key(const Literal& lit) : contents(lit) {}
            /**
             * Non-member swap function.
             * @param k1 will get k2's contents
             * @param k2 will get k1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API friend inline void swap(Key& k1, Key& k2) noexcept {
                using std::swap;

                swap(k1.contents, k2.contents);
            }
            /**
             * Assignment operator
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Key& operator=(Key) noexcept;
            /**
             * Less than operator. Compares the literal of `this` with the literal of `other`.
             * This method is used in representing the mapping from key lists to patterns
             * in a message with variants, and is not expected to be useful otherwise.
             *
             * @param other The Key to compare to this one.
             * @return true if the two `Key`s are not wildcards and if `this.asLiteral()`
             * < `other.asLiteral()`.
             * Returns false otherwise.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API bool operator<(const Key& other) const;
            /**
             * Equality operator. Compares the literal of `this` with the literal of `other`.
             * This method is used in representing the mapping from key lists to patterns
             * in a message with variants, and is not expected to be useful otherwise.
             *
             * @param other The Key to compare to this one.
             * @return true if either both `Key`s are wildcards, or `this.asLiteral()`
             * == `other.asLiteral()`.
             * Returns false otherwise.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API bool operator==(const Key& other) const;
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual ~Key();
        private:
            /* const */ std::optional<Literal> contents;
        }; // class Key

        /**
         * The `SelectorKeys` class represents the key list for a single variant.
         * It corresponds to the `keys` array in the `Variant` interface
         * defined in https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#messages
         *
         * `SelectorKeys` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API_CLASS SelectorKeys : public UObject {
        public:
            /**
             * Returns the underlying list of keys.
             *
             * @return The list of keys for this variant.
             *         Returns an empty list if allocating this `SelectorKeys`
             *         object previously failed.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API std::vector<Key> getKeys() const {
                return toStdVector<Key>(keys.getAlias(), len);
            }
            /**
             * The mutable `SelectorKeys::Builder` class allows the key list to be constructed
             * one key at a time.
             *
             * Builder is not copyable or movable.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            class U_I18N_API Builder : public UMemory {
            private:
                friend class SelectorKeys;
                UVector* keys; // This is a raw pointer and not a LocalPointer<UVector> to avoid undefined behavior warnings,
                               // since UVector is forward-declared
                               // The vector owns its elements
            public:
                /**
                 * Adds a single key to the list.
                 *
                 * @param key    The key to be added. Passed by move
                 * @param status Input/output error code
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& add(Key&& key, UErrorCode& status) noexcept;
                /**
                 * Constructs a new immutable `SelectorKeys` using the list of keys
                 * set with previous `add()` calls.
                 *
                 * The builder object (`this`) can still be used after calling `build()`.
                 *
                 * @param status    Input/output error code
                 * @return          The new SelectorKeys object
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                SelectorKeys build(UErrorCode& status) const;
                /**
                 * Default constructor.
                 * Returns a Builder with an empty list of keys.
                 *
                 * @param status Input/output error code
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder(UErrorCode& status);
                /**
                 * Destructor.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                virtual ~Builder();
                Builder(const Builder&) = delete;
                Builder& operator=(const Builder&) = delete;
                Builder(Builder&&) = delete;
                Builder& operator=(Builder&&) = delete;
            }; // class SelectorKeys::Builder
            /**
             * Less than operator. Compares the two key lists lexicographically.
             * This method makes it possible for a `SelectorKeys` to be used as a map
             * key, which allows variants to be represented as a map. It is not expected
             * to be useful otherwise.
             *
             * @param other The SelectorKeys to compare to this one.
             * @return true if `this` is less than `other`, comparing the two key lists
             * lexicographically.
             * Returns false otherwise.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API bool operator<(const SelectorKeys& other) const;
            /**
             * Default constructor.
             * Puts the SelectorKeys into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API SelectorKeys() : len(0) {}
            /**
             * Non-member swap function.
             * @param s1 will get s2's contents
             * @param s2 will get s1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API friend inline void swap(SelectorKeys& s1, SelectorKeys& s2) noexcept {
                using std::swap;

                swap(s1.len, s2.len);
                swap(s1.keys, s2.keys);
            }
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API SelectorKeys(const SelectorKeys& other);
            /**
             * Assignment operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API SelectorKeys& operator=(SelectorKeys other) noexcept;
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual ~SelectorKeys();
        private:
            friend class Builder;
            friend class message2::Checker;
            friend class message2::MessageFormatter;
            friend class message2::Serializer;

            /* const */ LocalArray<Key> keys;
            /* const */ int32_t len;

            const Key* getKeysInternal() const;
            SelectorKeys(const UVector& ks, UErrorCode& status);
        }; // class SelectorKeys

        class Operator;

        /**
         *  An `Option` pairs an option name with an Operand.
         *
         * `Option` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Option : public UObject {
        public:
            /**
             * Accesses the right-hand side of the option.
             *
             * @return A reference to the operand.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const Operand& getValue() const { return rand; }
            /**
             * Accesses the left-hand side of the option.
             *
             * @return A reference to the option name.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const UnicodeString& getName() const { return name; }
            /**
             * Constructor. Returns an `Option` representing the
             * named option "name=rand".
             *
             * @param n The name of the option.
             * @param r The value of the option.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Option(const UnicodeString& n, Operand&& r) : name(n), rand(std::move(r)) {}
            /**
             * Default constructor.
             * Returns an Option in a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Option() {}
            /**
             * Non-member swap function.
             * @param o1 will get o2's contents
             * @param o2 will get o1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            friend inline void swap(Option& o1, Option& o2) noexcept {
                using std::swap;

                swap(o1.name, o2.name);
                swap(o1.rand, o2.rand);
            }
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Option(const Option& other);
            /**
             * Assignment operator
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Option& operator=(Option other) noexcept;
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Option();
        private:
            /* const */ UnicodeString name;
            /* const */ Operand rand;
        }; // class Option

        // Internal only
        #ifndef U_IN_DOXYGEN
        // Options
        // This is a wrapper class around a vector of options that provides lookup operations
        class U_I18N_API_CLASS OptionMap : public UObject {
        public:
            U_I18N_API int32_t size() const;
            // Needs to take an error code b/c an earlier copy might have failed
            U_I18N_API const Option& getOption(int32_t, UErrorCode&) const;
            U_I18N_API friend inline void swap(OptionMap& m1, OptionMap& m2) noexcept {
                using std::swap;

                swap(m1.bogus, m2.bogus);
                swap(m1.options, m2.options);
                swap(m1.len, m2.len);
            }
            U_I18N_API OptionMap() : len(0) {}
            U_I18N_API OptionMap(const OptionMap&);
            U_I18N_API OptionMap& operator=(OptionMap);
            U_I18N_API std::vector<Option> getOptions() const {
                return toStdVector<Option>(options.getAlias(), len);
            }
            U_I18N_API OptionMap(const UVector&, UErrorCode&);
            U_I18N_API OptionMap(Option*, int32_t);
            U_I18N_API virtual ~OptionMap();

            class U_I18N_API Builder : public UObject {
                private:
                    UVector* options;
                    bool checkDuplicates = true;
                public:
                    Builder& add(Option&& opt, UErrorCode&);
                    Builder(UErrorCode&);
                    static Builder attributes(UErrorCode&);
                    // As this class is private, build() is destructive
                    OptionMap build(UErrorCode&);
		    friend inline void swap(Builder& m1, Builder& m2) noexcept {
		      using std::swap;

		      swap(m1.options, m2.options);
		      swap(m1.checkDuplicates, m2.checkDuplicates);
		    }
		    Builder(Builder&&);
		    Builder(const Builder&) = delete;
		    Builder& operator=(Builder) noexcept;
		    virtual ~Builder();
            }; // class OptionMap::Builder
        private:
            friend class message2::Serializer;

            bool bogus = false;
            LocalArray<Option> options;
            int32_t len;
        }; // class OptionMap
        #endif

        /**
         * The `Operator` class corresponds to the `FunctionRef` type in the
         * `Expression` interface defined in
         * https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#patterns
         *
         * It represents the annotation that an expression can have: a function name paired
         * with a map from option names to operands (possibly empty).
         *
         * `Operator` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Operator : public UObject {
        public:
            /**
             * Accesses the function name.
             *
             * @return The function name of this operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const FunctionName& getFunctionName() const;
            /**
             * Accesses function options.
             *
             * @return A vector of function options for this operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            std::vector<Option> getOptions() const {
                return options.getOptions();
            }
            /**
             * The mutable `Operator::Builder` class allows the operator to be constructed
             * incrementally.
             *
             * Builder is not copyable or movable.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            class U_I18N_API Builder : public UMemory {
            private:
                friend class Operator;
                FunctionName functionName;
                OptionMap::Builder options;
            public:
                /**
                 * Sets this operator to be a function annotation and sets its name
                 * to `func`.
                 *
                 * @param func The function name.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& setFunctionName(FunctionName&& func);
                /**
                 * Sets this operator to be a function annotation and adds a
                 * single option.
                 *
                 * @param key The name of the option.
                 * @param value The value (right-hand side) of the option.
                 * @param status Input/output error code.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& addOption(const UnicodeString &key, Operand&& value, UErrorCode& status) noexcept;
                /**
                 * Constructs a new immutable `Operator` using the
                 * function name and options that were previously set.
                 *
                 * The builder object (`this`) can still be used after calling `build()`.
                 *
                 * The `build()` method is non-const for internal implementation reasons,
                 * but is observably const.
                 *
                 * @param status    Input/output error code.
                 * @return          The new Operator
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Operator build(UErrorCode& status);
                /**
                 * Default constructor.
                 * Returns a Builder with no function name or options set.
                 *
                 * @param status    Input/output error code.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder(UErrorCode& status);
                /**
                 * Destructor.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                virtual ~Builder();
                Builder(const Builder&) = delete;
                Builder& operator=(const Builder&) = delete;
                Builder(Builder&&) = delete;
                Builder& operator=(Builder&&) = delete;
            }; // class Operator::Builder
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Operator(const Operator& other) noexcept;
            /**
             * Non-member swap function.
             * @param o1 will get o2's contents
             * @param o2 will get o1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            friend inline void swap(Operator& o1, Operator& o2) noexcept {
                using std::swap;

                swap(o1.name, o2.name);
                swap(o1.options, o2.options);
            }
            /**
             * Assignment operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Operator& operator=(Operator) noexcept;
            /**
             * Default constructor.
             * Puts the Operator into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Operator() {}
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Operator();
        private:
            friend class Binding;
            friend class Builder;
            friend class message2::Checker;
            friend class message2::MessageFormatter;
            friend class message2::Serializer;

            // Function call constructor
            Operator(const FunctionName& f, const UVector& options, UErrorCode&);

            const OptionMap& getOptionsInternal() const;
            Operator(const FunctionName&, const OptionMap&);

            /* const */ FunctionName name;
            /* const */ OptionMap options;
        }; // class Operator

      // Internal only
      typedef enum UMarkupType {
          UMARKUP_OPEN = 0,
          UMARKUP_CLOSE,
          UMARKUP_STANDALONE,
          UMARKUP_COUNT
      } UMarkupType;

      /**
         * The `Markup` class corresponds to the `markup` nonterminal in the MessageFormat 2
         * grammar and the `markup` interface defined in
         * https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model/message.json
         *
         * `Markup` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Markup : public UObject {
        public:
            /**
             * Checks if this markup is an opening tag.
             *
             * @return True if and only if this represents an opening tag.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            UBool isOpen() const { return (type == UMARKUP_OPEN); }
            /**
             * Checks if this markup is an closing tag.
             *
             * @return True if and only if this represents an closing tag.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            UBool isClose() const { return (type == UMARKUP_CLOSE); }
            /**
             * Checks if this markup is an standalone tag.
             *
             * @return True if and only if this represents a standalone tag.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            UBool isStandalone() const { return (type == UMARKUP_STANDALONE); }
            /**
             * Gets the name of this markup
             *
             * @return A reference to the string identifying the markup
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const UnicodeString& getName() const { return name; }
            /**
             * Gets the options of this markup
             *
             * @return A reference to the string identifying the markup
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            std::vector<Option> getOptions() const { return options.getOptions(); }
            /**
             * Gets the attributes of this markup
             *
             * @return A vector of attributes
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            std::vector<Option> getAttributes() const { return attributes.getOptions(); }
            /**
             * Default constructor.
             * Puts the Markup into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Markup() {}
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Markup();
            /**
             * The mutable `Markup::Builder` class allows the markup to be constructed
             * incrementally.
             *
             * Builder is not copyable or movable.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            class U_I18N_API Builder : public UMemory {
            private:
                friend class Markup;

                UnicodeString name;
                OptionMap::Builder options;
                OptionMap::Builder attributes;
                UMarkupType type = UMARKUP_COUNT;
            public:
                /**
                 * Sets the name of this markup.
                 *
                 * @param n A string representing the name.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& setName(const UnicodeString& n) { name = n; return *this; }
                /**
                 * Sets this to be an opening markup.
                 *
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& setOpen() { type = UMARKUP_OPEN; return *this; }
                /**
                 * Sets this to be an closing markup.
                 *
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& setClose() { type = UMARKUP_CLOSE; return *this; }
                /**
                 * Sets this to be a standalone markup.
                 *
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& setStandalone() { type = UMARKUP_STANDALONE; return *this; }
                /**
                 * Adds a single option.
                 *
                 * @param key The name of the option.
                 * @param value The value (right-hand side) of the option.
                 * @param status Input/output error code.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& addOption(const UnicodeString &key, Operand&& value, UErrorCode& status);
                /**
                 * Adds a single attribute.
                 *
                 * @param key The name of the attribute.
                 * @param value The value (right-hand side) of the attribute.
                 * @param status Input/output error code.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& addAttribute(const UnicodeString &key, Operand&& value, UErrorCode& status);
                /**
                 * Constructs a new immutable `Markup` using the name and type
                 * and (optionally) options and attributes that were previously set.
                 * If `setName()` and at least one of `setOpen()`, `setClose()`, and `setStandalone()`
                 * were not previously called,
                 * then `status` is set to U_INVALID_STATE_ERROR.
                 *
                 * The builder object (`this`) can still be used after calling `build()`.
                 * The `build()` method is non-const for internal implementation reasons,
                 * but is observably const.
                 *
                 * @param status    Input/output error code.
                 * @return          The new Markup.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Markup build(UErrorCode& status);
                /**
                 * Default constructor.
                 * Returns a Builder with no name, type, options, or attributes set.
                 *
                 * @param status    Input/output error code.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder(UErrorCode& status);
                /**
                 * Destructor.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                virtual ~Builder();
                Builder(const Builder&) = delete;
                Builder& operator=(const Builder&) = delete;
                Builder(Builder&&) = delete;
                Builder& operator=(Builder&&) = delete;
            }; // class Markup::Builder

        private:
            friend class Builder;
            friend class message2::Serializer;

            UMarkupType type;
            UnicodeString name;
            OptionMap options;
            OptionMap attributes;
            const OptionMap& getOptionsInternal() const { return options; }
            const OptionMap& getAttributesInternal() const { return attributes; }
            Markup(UMarkupType, UnicodeString, OptionMap&&, OptionMap&&);
        }; // class Markup

        /**
         * The `Expression` class corresponds to the `expression` nonterminal in the MessageFormat 2
         * grammar and the `Expression` interface defined in
         * https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#patterns
         *
         * It represents either an operand with no annotation; an annotation with no operand;
         * or an operand annotated with an annotation.
         *
         * `Expression` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API_CLASS Expression : public UObject {
        public:
            /**
             * Checks if this expression is an annotation
             * with no operand.
             *
             * @return True if and only if the expression has
             *         an annotation and has no operand.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isStandaloneAnnotation() const;
            /**
             * Checks if this expression has a function
             * annotation (with or without an operand).
             *
             * @return True if and only if the expression has an annotation
             *         that is a function.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isFunctionCall() const;
            /**
             * Accesses the function
             * annotating this expression.
             * If !(isFunctionCall()), sets
             * `status` to U_INVALID_STATE_ERROR.
             *
             * @param status Input/output error code.
             * @return A non-owned pointer to the operator of this expression,
             *         which does not outlive the expression.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const Operator* getOperator(UErrorCode& status) const;
            /**
             * Accesses the operand of this expression.
             *
             * @return A reference to the operand of this expression,
             *         which may be the null operand.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const Operand& getOperand() const;
            /**
             * Gets the attributes of this expression
             *
             * @return A vector of attributes
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API std::vector<Option> getAttributes() const { return attributes.getOptions(); }
            /**
             * The mutable `Expression::Builder` class allows the operator to be constructed
             * incrementally.
             *
             * Builder is not copyable or movable.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            class U_I18N_API Builder : public UMemory {
            private:
                friend class Expression;

                bool hasOperand = false;
                bool hasOperator = false;
                Operand rand;
                Operator rator;
                OptionMap::Builder attributes;
            public:
                /**
                 * Sets the operand of this expression.
                 *
                 * @param rAnd The operand to set. Passed by move.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& setOperand(Operand&& rAnd);
                /**
                 * Sets the operator of this expression.
                 *
                 * @param rAtor The operator to set. Passed by move.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& setOperator(Operator&& rAtor);
                /**
                 * Adds a single attribute.
                 *
                 * @param key The name of the attribute.
                 * @param value The value (right-hand side) of the attribute.
                 * @param status Input/output error code.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& addAttribute(const UnicodeString &key, Operand&& value, UErrorCode& status);
                /**
                 * Constructs a new immutable `Expression` using the operand and operator that
                 * were previously set. If neither `setOperand()` nor `setOperator()` was
                 * previously called, or if `setOperand()` was called with the null operand
                 * and `setOperator()` was never called, then `status` is set to
                 * U_INVALID_STATE_ERROR.
                 *
                 * The builder object (`this`) can still be used after calling `build()`.
                 * The `build()` method is non-const for internal implementation reasons,
                 * but is observably const.

                 * @param status    Input/output error code.
                 * @return          The new Expression.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Expression build(UErrorCode& status);
                /**
                 * Default constructor.
                 * Returns a Builder with no operator or operand set.
                 *
                 * @param status    Input/output error code.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder(UErrorCode& status);
                /**
                 * Destructor.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                virtual ~Builder();
                Builder(const Builder&) = delete;
                Builder& operator=(const Builder&) = delete;
                Builder(Builder&&) = delete;
                Builder& operator=(Builder&&) = delete;
            }; // class Expression::Builder
            /**
             * Non-member swap function.
             * @param e1 will get e2's contents
             * @param e2 will get e1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API friend inline void swap(Expression& e1, Expression& e2) noexcept {
                using std::swap;

                swap(e1.rator, e2.rator);
                swap(e1.rand, e2.rand);
                swap(e1.attributes, e2.attributes);
            }
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Expression(const Expression& other);
            /**
             * Assignment operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Expression& operator=(Expression) noexcept;
            /**
             * Default constructor.
             * Puts the Expression into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Expression();
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual ~Expression();
        private:
            friend class message2::Serializer;

            /*
              Internally, an expression is represented as the application of an optional operator to an operand.
              The operand is always present; for function calls with no operand, it's represented
              as an operand for which `isNull()` is true.

              Operator               | Operand
              --------------------------------
              { |42| :fun opt=value } =>  (FunctionName=fun,     | Literal(quoted=true, contents="42")
              options={opt: value})
              { abcd }                =>  null                   | Literal(quoted=false, contents="abcd")
              { : fun opt=value }     =>  (FunctionName=fun,
              options={opt: value})  | NullOperand()
            */

            Expression(const Operator &rAtor, const Operand &rAnd, const OptionMap& attrs) : rator(rAtor), rand(rAnd), attributes(attrs) {}
            Expression(const Operand &rAnd, const OptionMap& attrs) : rator(std::nullopt), rand(Operand(rAnd)), attributes(attrs) {}
            Expression(const Operator &rAtor, const OptionMap& attrs) : rator(rAtor), rand(), attributes(attrs) {}
            /* const */ std::optional<Operator> rator;
            /* const */ Operand rand;
            /* const */ OptionMap attributes;
            const OptionMap& getAttributesInternal() const { return attributes; }
        }; // class Expression

      class Pattern;

  // Despite the comments, `PatternPart` is internal-only
       /**
         *  A `PatternPart` is a single element (text or expression) in a `Pattern`.
         * It corresponds to the `body` field of the `Pattern` interface
         *  defined in https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#patterns
         *
         * `PatternPart` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API_CLASS PatternPart : public UObject {
        public:
            /**
             * Checks if the part is a text part.
             *
             * @return True if and only if this is a text part.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isText() const { return std::holds_alternative<UnicodeString>(piece); }
            /**
             * Checks if the part is a markup part.
             *
             * @return True if and only if this is a markup part.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isMarkup() const { return std::holds_alternative<Markup>(piece); }
            /**
             * Checks if the part is an expression part.
             *
             * @return True if and only if this is an expression part.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API UBool isExpression() const { return std::holds_alternative<Expression>(piece); }
            /**
             * Accesses the expression of the part.
             * Precondition: isExpression()
             *
             * @return A reference to the part's underlying expression.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const Expression& contents() const;
            /**
             * Accesses the expression of the part.
             * Precondition: isMarkup()
             *
             * @return A reference to the part's underlying expression.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const Markup& asMarkup() const;
            /**
             * Accesses the text contents of the part.
             * Precondition: isText()
             *
             * @return A reference to a string representing the part's text..
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API const UnicodeString& asText() const;
            /**
             * Non-member swap function.
             * @param p1 will get p2's contents
             * @param p2 will get p1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API friend inline void swap(PatternPart& p1, PatternPart& p2) noexcept {
                using std::swap;

                swap(p1.piece, p2.piece);
            }
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API PatternPart(const PatternPart& other);
            /**
             * Assignment operator.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API PatternPart& operator=(PatternPart) noexcept;
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual ~PatternPart();
            /**
             * Text part constructor. Returns a text pattern part
             * with text `t`.
             *
             * @param t A text string.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API explicit PatternPart(const UnicodeString& t) : piece(t) {}
            /**
             * Expression part constructor. Returns an Expression pattern
             * part with expression `e`.
             *
             * @param e An Expression.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API explicit PatternPart(Expression&& e) : piece(e) {}
            /**
             * Markup part constructor. Returns a Markup pattern
             * part with markup `m`
             *
             * @param m A Markup.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API explicit PatternPart(Markup&& m) : piece(m) {}
            /**
             * Default constructor.
             * Puts the PatternPart into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API PatternPart() = default;
        private:
            friend class Pattern;

            std::variant<UnicodeString, Expression, Markup> piece;
        }; // class PatternPart

        /**
         *  A `Pattern` is a sequence of formattable parts.
         * It corresponds to the `Pattern` interface
         * defined in https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#patterns
         *
         * `Pattern` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API_CLASS Pattern : public UObject {
        private:
            friend class PatternPart;

        public:
            #ifndef U_IN_DOXYGEN
            struct U_I18N_API Iterator;
            #endif
            /**
             * Returns the parts of this pattern
             *
             * @return A forward iterator of variants. Each element is either a string (text part)
             *         or an expression part.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Iterator begin() const {
                return Iterator(this, 0);
            }
            /**
             * Returns a special value to mark the end of iteration
             *
             * @return A forward iterator of variants. This should only be used for comparisons
             *         against an iterator returned by incrementing begin().
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Iterator end() const {
                return Iterator(this, len);
            }
            /**
             * The mutable `Pattern::Builder` class allows the pattern to be
             * constructed one part at a time.
             *
             * Builder is not copyable or movable.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            class U_I18N_API Builder : public UMemory {
            private:
                friend class Pattern;

                UVector* parts;  // Not a LocalPointer for the same reason as in `SelectorKeys::Builder`

            public:
                /**
                 * Adds a single expression part to the pattern.
                 *
                 * @param part The part to be added (passed by move)
                 * @param status Input/output error code.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& add(Expression&& part, UErrorCode& status) noexcept;
                /**
                 * Adds a single markup part to the pattern.
                 *
                 * @param part The part to be added (passed by move)
                 * @param status Input/output error code.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& add(Markup&& part, UErrorCode& status) noexcept;
                /**
                 * Adds a single text part to the pattern. Copies `part`.
                 *
                 * @param part The part to be added (passed by move)
                 * @param status Input/output error code.
                 * @return A reference to the builder.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder& add(UnicodeString&& part, UErrorCode& status) noexcept;
                /**
                 * Constructs a new immutable `Pattern` using the list of parts
                 * set with previous `add()` calls.
                 *
                 * The builder object (`this`) can still be used after calling `build()`.
                 *
                 * @param status    Input/output error code.
                 * @return          The pattern object
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Pattern build(UErrorCode& status) const noexcept;
                /**
                 * Default constructor.
                 * Returns a Builder with an empty sequence of PatternParts.
                 *
                 * @param status Input/output error code
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Builder(UErrorCode& status);
                /**
                 * Destructor.
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                virtual ~Builder();
                Builder(const Builder&) = delete;
                Builder& operator=(const Builder&) = delete;
                Builder(Builder&&) = delete;
                Builder& operator=(Builder&&) = delete;
            }; // class Pattern::Builder

            /**
             * Default constructor.
             * Puts the Pattern into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Pattern() : parts(LocalArray<PatternPart>()) {}
            /**
             * Non-member swap function.
             * @param p1 will get p2's contents
             * @param p2 will get p1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API friend inline void swap(Pattern& p1, Pattern& p2) noexcept {
                using std::swap;

                swap(p1.bogus, p2.bogus);
                swap(p1.len, p2.len);
                swap(p1.parts, p2.parts);
            }
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Pattern(const Pattern& other);
            /**
             * Assignment operator
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API Pattern& operator=(Pattern) noexcept;
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            U_I18N_API virtual ~Pattern();

            /**
             *  The `Pattern::Iterator` class provides an iterator over the formattable
             * parts of a pattern.
             *
             * `Pattern::Iterator` is mutable and is not copyable or movable.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            struct U_I18N_API Iterator {
            private:
                using iterator_category = std::forward_iterator_tag;
                using difference_type = std::ptrdiff_t;
                using value_type = std::variant<UnicodeString, Expression, Markup>;
                using pointer = value_type*;
                using reference = const value_type&;

                friend class Pattern;
                Iterator(const Pattern* p, int32_t i) : pos(i), pat(p) {}
                friend bool operator== (const Iterator& a, const Iterator& b) { return (a.pat == b.pat && a.pos == b.pos); }

                int32_t pos;
                const Pattern* pat;

            public:
                /**
                 * Dereference operator (gets the element at the current iterator position)
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                reference operator*() const {
                    const PatternPart& part = pat->parts[pos];
                    return patternContents(part);
                }
                /**
                 * Increment operator (advances to the next iterator position)
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                Iterator operator++() { pos++; return *this; }
                /**
                 * Inequality comparison operator (used for comparing an iterator to the result of end())
                 *
                 * @internal ICU 75 technology preview
                 * @deprecated This API is for technology preview only.
                 */
                friend bool operator!= (const Iterator& a, const Iterator& b) { return !(a == b); }
            }; // struct Iterator

        private:
            friend class Builder;
            friend class message2::MessageFormatter;
            friend class message2::Serializer;

            // Set to true if a copy constructor fails;
            // needed in order to distinguish an uninitialized
            // Pattern from a 0-length pattern
            bool bogus = false;

            // Possibly-empty array of parts
            int32_t len = 0;
            LocalArray<PatternPart> parts;

            Pattern(const UVector& parts, UErrorCode& status);
            // Helper
            static void initParts(Pattern&, const Pattern&);

            /**
             * Returns the size.
             *
             * @return The number of parts in the pattern.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            int32_t numParts() const;
            /**
             * Returns the `i`th part in the pattern.
             * Precondition: i < numParts()
             *
             * @param i Index of the part being accessed.
             * @return  A reference to the part at index `i`.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const PatternPart& getPart(int32_t i) const;

            // Gets around not being able to declare Pattern::Iterator as a friend
            // in PatternPart
            static const std::variant<UnicodeString, Expression, Markup>&
                patternContents(const PatternPart& p) { return p.piece; }
        }; // class Pattern

        /**
         *  A `Variant` pairs a list of keys with a pattern
         * It corresponds to the `Variant` interface
         * defined in https://github.com/unicode-org/message-format-wg/tree/main/spec/data-model
         *
         * `Variant` is immutable, copyable and movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Variant : public UObject {
        public:
            /**
             * Accesses the pattern of the variant.
             *
             * @return A reference to the pattern.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const Pattern& getPattern() const { return p; }
            /**
             * Accesses the keys of the variant.
             *
             * @return A reference to the keys.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const SelectorKeys& getKeys() const { return k; }
            /**
             * Constructor. Returns a variant that formats to `pattern`
             * when `keys` match the selector expressions in the enclosing
             * `match` construct.
             *
             * @param keys A reference to a `SelectorKeys`.
             * @param pattern A pattern (passed by move)
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Variant(const SelectorKeys& keys, Pattern&& pattern) : k(keys), p(std::move(pattern)) {}
            /**
             * Non-member swap function.
             * @param v1 will get v2's contents
             * @param v2 will get v1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            friend inline void swap(Variant& v1, Variant& v2) noexcept {
                using std::swap;

                swap(v1.k, v2.k);
                swap(v1.p, v2.p);
            }
            /**
             * Assignment operator
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Variant& operator=(Variant other) noexcept;
            /**
             * Default constructor.
             * Returns a Variant in a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Variant() = default;
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Variant(const Variant&);
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Variant();
        private:
            /* const */ SelectorKeys k;
            /* const */ Pattern p;
        }; // class Variant

        /**
         *  A `Binding` pairs a variable name with an expression.
         * It corresponds to the `Declaration` interface
         * defined in https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md#messages
         *
         * `Binding` is immutable and copyable. It is not movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Binding : public UObject {
        public:
            /**
             * Accesses the right-hand side of a binding.
             *
             * @return A reference to the expression.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const Expression& getValue() const;
            /**
             * Accesses the left-hand side of the binding.
             *
             * @return A reference to the variable name.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            const VariableName& getVariable() const { return var; }
            /**
             * Constructor for input binding.
             *
             * @param variableName The variable name (left-hand side) of the binding. Passed by move.
             * @param rhs The right-hand side of the input binding. Passed by move.
             *                   `rhs` must have an operand that is a variable reference to `variableName`.
             *                   If `rhs` has an operator, it must be a function call.
             *                   If either of these properties is violated, `errorCode` is set to
             *                   U_INVALID_STATE_ERROR.
             * @param errorCode Input/output error code
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            static Binding input(UnicodeString&& variableName, Expression&& rhs, UErrorCode& errorCode);
            /**
             * Returns true if and only if this binding represents a local declaration.
             * Otherwise, it's an input declaration.
             *
             * @return True if this binding represents a variable and expression;
             *         false if it represents a variable plus an annotation.
             * @internal ICU 78 technology preview
             * @deprecated This API is for technology preview only.
             */
            UBool isLocal() const { return local; }
            /**
             * Constructor.
             *
             * @param v A variable name.
             * @param e An expression.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Binding(const VariableName& v, Expression&& e) : var(v), expr(std::move(e)), local(true), annotation(nullptr) {}
            /**
             * Non-member swap function.
             * @param b1 will get b2's contents
             * @param b2 will get b1's contents
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            friend inline void swap(Binding& b1, Binding& b2) noexcept {
                using std::swap;

                swap(b1.var, b2.var);
                swap(b1.expr, b2.expr);
                swap(b1.local, b2.local);
                b1.updateAnnotation();
                b2.updateAnnotation();
            }
            /**
             * Copy constructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Binding(const Binding& other);
            /**
             * Copy assignment operator
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Binding& operator=(Binding) noexcept;
            /**
             * Default constructor.
             * Puts the Binding into a valid but undefined state.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Binding() : local(true) {}
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Binding();
        private:
            friend class message2::Checker;
            friend class message2::MessageFormatter;
            friend class message2::Parser;
            friend class message2::Serializer;

            /* const */ VariableName var;
            /* const */ Expression expr;
            /* const */ bool local;

            // The following field is always nullptr for a local
            // declaration, and possibly nullptr for an .input declaration
            // If non-null, the referent is a member of `expr` so
            // its lifetime is the same as the lifetime of the enclosing Binding
            // (as long as there's no mutation)
            const Operator* annotation = nullptr;

            const OptionMap& getOptionsInternal() const;

            bool hasAnnotation() const { return !local && (annotation != nullptr); }
            void updateAnnotation();
        }; // class Binding

    // Internal only

    #ifndef U_IN_DOXYGEN
    class U_I18N_API_CLASS Matcher : public UObject {
    public:
        U_I18N_API Matcher& operator=(Matcher);
        U_I18N_API Matcher(const Matcher&);
        /**
         * Non-member swap function.
         * @param m1 will get m2's contents
         * @param m2 will get m1's contents
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API friend inline void swap(Matcher& m1, Matcher& m2) noexcept {
            using std::swap;

            if (m1.bogus) {
                m2.bogus = true;
                return;
            }
            if (m2.bogus) {
                m1.bogus = true;
                return;
            }
            swap(m1.selectors, m2.selectors);
            swap(m1.numSelectors, m2.numSelectors);
            swap(m1.variants, m2.variants);
            swap(m1.numVariants, m2.numVariants);
        }
        U_I18N_API virtual ~Matcher();
    private:

        friend class MFDataModel;

        Matcher(VariableName* ss, int32_t ns, Variant* vs, int32_t nv);
        Matcher() {}

        // A Matcher may have numSelectors=0 and numVariants=0
        // (this is a data model error, but it's representable).
        // So we have to keep a separate flag to track failed copies.
        bool bogus = false;

        // The variables that are being matched on.
        LocalArray<VariableName> selectors;
        // The number of selectors
        int32_t numSelectors = 0;
        // The list of `when` clauses (case arms).
        LocalArray<Variant> variants;
        // The number of variants
        int32_t numVariants = 0;
    }; // class Matcher
    #endif

    // -----------------------------------------------------------------------
    // Public MFDataModel class

    /**
     *
     * The `MFDataModel` class describes a parsed representation of the text of a message.
     * This representation is public as higher-level APIs for messages will need to know its public
     * interface: for example, to re-instantiate a parsed message with different values for imported
     variables.
     *
     * The MFDataModel API implements <a target="github"
     href="https://github.com/unicode-org/message-format-wg/blob/main/spec/data-model.md">the
     * specification of the abstract syntax (data model representation)</a> for MessageFormat.
     *
     * `MFDataModel` is immutable, copyable and movable.
     *
     * @internal ICU 75 technology preview
     * @deprecated This API is for technology preview only.
     */
    class U_I18N_API_CLASS MFDataModel : public UMemory {
        /*
          Classes that represent nodes in the data model are nested inside the
          `MFDataModel` class.

          Classes such as `Expression`, `Pattern` and `VariantMap` are immutable and
          are constructed using the builder pattern.

          Most classes representing nodes have copy constructors. This is because builders
          contain immutable data that must be copied when calling `build()`, since the builder
          could go out of scope before the immutable result of the builder does. Copying is
          also necessary to prevent unexpected mutation if intermediate builders are saved
          and mutated again after calling `build()`.

          The copy constructors perform a deep copy, for example by copying the entire
          list of options for an `Operator` (and copying the entire underlying vector.)
          Some internal fields should be `const`, but are declared as non-`const` to make
          the copy constructor simpler to implement. (These are noted throughout.) In
          other words, those fields are `const` except during the execution of a copy
          constructor.

          On the other hand, intermediate `Builder` methods that return a `Builder&`
          mutate the state of the builder, so in code like:

          Expression::Builder& exprBuilder = Expression::builder()-> setOperand(foo);
          Expression::Builder& exprBuilder2 = exprBuilder.setOperator(bar);

          the call to `setOperator()` would mutate `exprBuilder`, since `exprBuilder`
          and `exprBuilder2` are references to the same object.

          An alternate choice would be to make `build()` destructive, so that copying would
          be unnecessary. Or, both copying and moving variants of `build()` could be
          provided. Copying variants of the intermediate `Builder` methods could be
          provided as well, if this proved useful.
        */
    public:
        /**
         * Accesses the local variable declarations for this data model.
         *
         * @return A vector of bindings for local variables.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API std::vector<Binding> getLocalVariables() const {
            std::vector<Binding> result;
            if (!bogus) {
                return toStdVector<Binding>(bindings.getAlias(), bindingsLen);
            }
            return {};
        }
        /**
         * Accesses the selectors. Returns an empty vector if this is a pattern message.
         *
         * @return A vector of selectors.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API std::vector<VariableName> getSelectors() const {
            if (std::holds_alternative<Pattern>(body)) {
                return {};
            }
            const Matcher* match = std::get_if<Matcher>(&body);
            // match must be non-null, given the previous check
            return toStdVector<VariableName>(match->selectors.getAlias(), match->numSelectors);
        }
        /**
         * Accesses the variants. Returns an empty vector if this is a pattern message.
         *
         * @return A vector of variants.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API std::vector<Variant> getVariants() const {
            // Return empty vector if no variants
            if (std::holds_alternative<Pattern>(body)) {
                return {};
            }
            const Matcher* match = std::get_if<Matcher>(&body);
            // match must be non-null, given the previous check
            return toStdVector<Variant>(match->variants.getAlias(), match->numVariants);
            return {};
        }
        /**
         * Accesses the pattern (in a message without selectors).
         * Returns a reference to an empty pattern if the message has selectors.
         *
         * @return A reference to the pattern.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API const Pattern& getPattern() const;
        /**
         * The mutable `MFDataModel::Builder` class allows the data model to be
         * constructed incrementally.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Builder;
        /**
         * Default constructor.
         * Puts the MFDataModel into a valid but undefined state.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API MFDataModel();
        /**
         * Non-member swap function.
         * @param m1 will get m2's contents
         * @param m2 will get m1's contents
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API friend inline void swap(MFDataModel& m1, MFDataModel& m2) noexcept {
            using std::swap;

            if (m1.bogus) {
                m2.bogus = true;
                return;
            }
            if (m2.bogus) {
                m1.bogus = true;
                return;
            }
            swap(m1.body, m2.body);
            swap(m1.bindings, m2.bindings);
            swap(m1.bindingsLen, m2.bindingsLen);
        }
        /**
         * Assignment operator
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API MFDataModel& operator=(MFDataModel) noexcept;
        /**
         * Copy constructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API MFDataModel(const MFDataModel& other);
        /**
         * Destructor.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        U_I18N_API virtual ~MFDataModel();

        /**
         * The mutable `MFDataModel::Builder` class allows the data model to be
         * constructed incrementally. Builder is not copyable or movable.
         *
         * @internal ICU 75 technology preview
         * @deprecated This API is for technology preview only.
         */
        class U_I18N_API Builder : public UMemory {
        private:
            friend class MFDataModel;

            void checkDuplicate(const VariableName&, UErrorCode&) const;
            void buildSelectorsMessage(UErrorCode&);
            bool hasPattern = true;
            bool hasSelectors = false;
            Pattern pattern;
            // The following members are not LocalPointers for the same reason as in SelectorKeys::Builder
            UVector* selectors = nullptr;
            UVector* variants = nullptr;
            UVector* bindings = nullptr;
        public:
            /**
             * Adds a binding, There must not already be a binding
             * with the same name.
             *
             * @param b The binding. Passed by move.
             * @param status Input/output error code. Set to U_DUPLICATE_DECLARATION_ERROR
             *                   if `addBinding()` was previously called with a binding
             *                   with the same variable name as `b`.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder& addBinding(Binding&& b, UErrorCode& status);
            /**
             * Adds a selector variable.
             * If a pattern was previously set, clears the pattern.
             *
             * @param selector Variable to add as a selector. Passed by move.
             * @param errorCode Input/output error code
             * @return A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder& addSelector(VariableName&& selector, UErrorCode& errorCode);
            /**
             * Adds a single variant.
             * If a pattern was previously set using `setPattern()`, clears the pattern.
             *
             * @param keys Keys for the variant. Passed by move.
             * @param pattern Pattern for the variant. Passed by move.
             * @param errorCode Input/output error code
             * @return A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder& addVariant(SelectorKeys&& keys, Pattern&& pattern, UErrorCode& errorCode) noexcept;
            /**
             * Sets the body of the message as a pattern.
             * If selectors and/or variants were previously set, clears them.
             *
             * @param pattern Pattern to represent the body of the message.
             *                Passed by move.
             * @return A reference to the builder.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder& setPattern(Pattern&& pattern);
            /**
             * Constructs a new immutable data model.
             * If `setPattern()` has not been called and if `addSelector()` and
             * `addVariant()` were not each called at least once,
             * `status` is set to `U_INVALID_STATE_ERROR`.
             * If `addSelector()` was called and `addVariant()` was never called,
             * or vice versa, then `status` is set to U_INVALID_STATE_ERROR.
             * Otherwise, either a Pattern or Selectors message is constructed
             * based on the pattern that was previously set, or selectors and variants
             * that were previously set.
             *
             * The builder object (`this`) can still be used after calling `build()`.
             *
             * @param status Input/output error code.
             * @return       The new MFDataModel
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            MFDataModel build(UErrorCode& status) const noexcept;
            /**
             * Default constructor.
             * Returns a Builder with no pattern or selectors set.
             * Either `setPattern()` or both `addSelector()` and
             * `addVariant()` must be called before calling `build()`
             * on the resulting builder.
             *
             * @param status Input/output error code.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            Builder(UErrorCode& status);
            /**
             * Destructor.
             *
             * @internal ICU 75 technology preview
             * @deprecated This API is for technology preview only.
             */
            virtual ~Builder();
            Builder(const Builder&) = delete;
            Builder& operator=(const Builder&) = delete;
            Builder(Builder&&) = delete;
            Builder& operator=(Builder&&) = delete;
        }; // class Builder

    private:
        friend class message2::Checker;
        friend class message2::MessageFormatter;
        friend class message2::Serializer;

        Pattern empty; // Provided so that `getPattern()` can return a result
                       // if called on a selectors message
        bool hasPattern() const { return std::holds_alternative<Pattern>(body); }

        bool bogus = false; // Set if a copy constructor fails

        // A message body is either a matcher (selector list and variant list),
        // or a single pattern
        std::variant<Matcher, Pattern> body;

        // Bindings for local variables
        /* const */ LocalArray<Binding> bindings;
        int32_t bindingsLen = 0;

        const Binding* getLocalVariablesInternal() const;
        const VariableName* getSelectorsInternal() const;
        const Variant* getVariantsInternal() const;

        int32_t numSelectors() const {
            const Matcher* matcher = std::get_if<Matcher>(&body);
            return (matcher == nullptr ? 0 : matcher->numSelectors);
        }
        int32_t numVariants() const {
            const Matcher* matcher = std::get_if<Matcher>(&body);
            return (matcher == nullptr ? 0 : matcher->numVariants);
        }

        // Helper
        void initBindings(const Binding*);

        MFDataModel(const Builder& builder, UErrorCode&) noexcept;
    }; // class MFDataModel
  } // namespace data_model
} // namespace message2

U_NAMESPACE_END

#endif // U_HIDE_DEPRECATED_API

#endif /* #if !UCONFIG_NO_MF2 */

#endif /* #if !UCONFIG_NO_FORMATTING */

#endif /* #if !UCONFIG_NO_NORMALIZATION */

#endif /* U_SHOW_CPLUSPLUS_API */

#endif // MESSAGEFORMAT_DATA_MODEL_H

// eof

