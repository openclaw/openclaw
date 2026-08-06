//
//  ZKSwizzle.h
//  ZKSwizzle
//
//  Created by Alexander S Zielenski on 7/24/14.
//  Copyright (c) 2014 Alexander S Zielenski. All rights reserved.
//

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <sys/cdefs.h>

// This is a class for streamlining swizzling. Simply create a new class of any name you want and
// Example:
/*
 @interface ZKHookClass : NSObject
 - (NSString *)description; // hooks -description on NSObject
 - (void)addedMethod; // all subclasses of NSObject now respond to -addedMethod
 @end

 @implementation ZKHookClass
 ...
 @end

 [ZKSwizzle swizzleClass:ZKClass(ZKHookClass) forClass:ZKClass(destination)];
 */

#ifndef ZKSWIZZLE_DEFS
#define ZKSWIZZLE_DEFS

// CRAZY MACROS FOR DYNAMIC PROTOTYPE CREATION
#define VA_NUM_ARGS(...) VA_NUM_ARGS_IMPL(0, ## __VA_ARGS__, 20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5 ,4 ,3 ,2, 1, 0)
#define VA_NUM_ARGS_IMPL(_0, _1,_2,_3,_4,_5, _6, _7, _8, _9, _10, _11, _12, _13, _14, _15, _16, _17, _18, _19, _20 ,N,...) N

#define WRAP0()
#define WRAP1(VARIABLE) , typeof ( VARIABLE )
#define WRAP2(VARIABLE, ...) WRAP1(VARIABLE) WRAP1(__VA_ARGS__)
#define WRAP3(VARIABLE, ...) WRAP1(VARIABLE) WRAP2(__VA_ARGS__)
#define WRAP4(VARIABLE, ...) WRAP1(VARIABLE) WRAP3(__VA_ARGS__)
#define WRAP5(VARIABLE, ...) WRAP1(VARIABLE) WRAP4(__VA_ARGS__)
#define WRAP6(VARIABLE, ...) WRAP1(VARIABLE) WRAP5(__VA_ARGS__)
#define WRAP7(VARIABLE, ...) WRAP1(VARIABLE) WRAP6(__VA_ARGS__)
#define WRAP8(VARIABLE, ...) WRAP1(VARIABLE) WRAP7(__VA_ARGS__)
#define WRAP9(VARIABLE, ...) WRAP1(VARIABLE) WRAP8(__VA_ARGS__)
#define WRAP10(VARIABLE, ...) WRAP1(VARIABLE) WRAP9(__VA_ARGS__)
#define WRAP11(VARIABLE, ...) WRAP1(VARIABLE) WRAP10(__VA_ARGS__)
#define WRAP12(VARIABLE, ...) WRAP1(VARIABLE) WRAP11(__VA_ARGS__)
#define WRAP13(VARIABLE, ...) WRAP1(VARIABLE) WRAP12(__VA_ARGS__)
#define WRAP14(VARIABLE, ...) WRAP1(VARIABLE) WRAP13(__VA_ARGS__)
#define WRAP15(VARIABLE, ...) WRAP1(VARIABLE) WRAP14(__VA_ARGS__)
#define WRAP16(VARIABLE, ...) WRAP1(VARIABLE) WRAP15(__VA_ARGS__)
#define WRAP17(VARIABLE, ...) WRAP1(VARIABLE) WRAP16(__VA_ARGS__)
#define WRAP18(VARIABLE, ...) WRAP1(VARIABLE) WRAP17(__VA_ARGS__)
#define WRAP19(VARIABLE, ...) WRAP1(VARIABLE) WRAP18(__VA_ARGS__)
#define WRAP20(VARIABLE, ...) WRAP1(VARIABLE) WRAP19(__VA_ARGS__)

#define CAT(A, B) A ## B
#define INVOKE(MACRO, NUMBER, ...) CAT(MACRO, NUMBER)(__VA_ARGS__)
#define WRAP_LIST(...) INVOKE(WRAP, VA_NUM_ARGS(__VA_ARGS__), __VA_ARGS__)

// Gets the a class with the name CLASS
#define ZKClass(CLASS) objc_getClass(#CLASS)

// returns the value of an instance variable.
#if !__has_feature(objc_arc)
#define ZKHookIvar(OBJECT, TYPE, NAME) (*(TYPE *)ZKIvarPointer(OBJECT, NAME))
#else
#define ZKHookIvar(OBJECT, TYPE, NAME) \
    _Pragma("clang diagnostic push") \
    _Pragma("clang diagnostic ignored \"-Wignored-attributes\"") \
    (*(__unsafe_unretained TYPE *)ZKIvarPointer(OBJECT, NAME)) \
    _Pragma("clang diagnostic pop")
#endif
// returns the original implementation of the swizzled function or null or not found
#define ZKOrig(TYPE, ...) ((TYPE (*)(id, SEL WRAP_LIST(__VA_ARGS__)))(ZKOriginalImplementation(self, _cmd, __PRETTY_FUNCTION__)))(self, _cmd, ##__VA_ARGS__)

// returns the original implementation of the superclass of the object swizzled
#define ZKSuper(TYPE, ...) ((TYPE (*)(id, SEL WRAP_LIST(__VA_ARGS__)))(ZKSuperImplementation(self, _cmd, __PRETTY_FUNCTION__)))(self, _cmd, ##__VA_ARGS__)

#define _ZKSwizzleInterfaceConditionally(CLASS_NAME, TARGET_CLASS, SUPERCLASS, GROUP, IMMEDIATELY) \
    @interface _$ ## CLASS_NAME : SUPERCLASS @end \
    @implementation _$ ## CLASS_NAME \
    + (void)initialize {} \
    @end \
    @interface CLASS_NAME : _$ ## CLASS_NAME @end \
    @implementation CLASS_NAME (ZKSWIZZLE) \
    + (void)load { \
        _$ZKRegisterInterface(self, #GROUP);\
        if (IMMEDIATELY) { \
            [self _ZK_unconditionallySwizzle]; \
        } \
    } \
    + (void)_ZK_unconditionallySwizzle { \
        ZKSwizzle(CLASS_NAME, TARGET_CLASS); \
    } \
@end

// Bootstraps your swizzling class so that it requires no setup
// outside of this macro call
// If you override +load you must call ZKSwizzle(CLASS_NAME, TARGET_CLASS)
// yourself, otherwise the swizzling would not take place
#define ZKSwizzleInterface(CLASS_NAME, TARGET_CLASS, SUPERCLASS) \
    _ZKSwizzleInterfaceConditionally(CLASS_NAME, TARGET_CLASS, SUPERCLASS, ZK_UNGROUPED, YES)

// Same as ZKSwizzleInterface, except
#define ZKSwizzleInterfaceGroup(CLASS_NAME, TARGET_CLASS, SUPER_CLASS, GROUP) \
    _ZKSwizzleInterfaceConditionally(CLASS_NAME, TARGET_CLASS, SUPER_CLASS, GROUP, NO)

__BEGIN_DECLS

// Make sure to cast this before you use it
typedef id (*ZKIMP)(id, SEL, ...);

// returns a pointer to the instance variable "name" on the object
void *ZKIvarPointer(id self, const char *name);
// returns the original implementation of a method with selector "sel" of an object hooked by the methods below
ZKIMP ZKOriginalImplementation(id self, SEL sel, const char *info);
// returns the implementation of a method with selector "sel" of the superclass of object
ZKIMP ZKSuperImplementation(id object, SEL sel, const char *info);

// hooks all the implemented methods of source with destination
// adds any methods that arent implemented on destination to destination that are implemented in source
#define ZKSwizzle(src, dst) _ZKSwizzle(ZKClass(src), ZKClass(dst))
BOOL _ZKSwizzle(Class src, Class dest);

#define ZKSwizzleGroup(NAME) _ZKSwizzleGroup(#NAME)
void _$ZKRegisterInterface(Class cls, const char *groupName);
BOOL _ZKSwizzleGroup(const char *groupName);

// Calls above method with the superclass of source for desination
#define ZKSwizzleClass(src) _ZKSwizzleClass(ZKClass(src))
BOOL _ZKSwizzleClass(Class cls);

__END_DECLS
#endif
