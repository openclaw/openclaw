//
//  CTBlockDescription.m
//  CTBlockDescription
//
//  Created by Oliver Letterer on 01.09.12.
//  Copyright (c) 2012 olettere. All rights reserved.
//

#import <Foundation/Foundation.h>
#import "CTBlockDescription.h"

@implementation CTBlockDescription

- (id)initWithBlock:(id)block
{
    if (self = [super init]) {
        _block = block;

        struct CTBlockLiteral *blockRef = (__bridge struct CTBlockLiteral *)block;
        _flags = blockRef->flags;
        _size = blockRef->descriptor->size;

        if (_flags & CTBlockDescriptionFlagsHasSignature) {
            void *signatureLocation = blockRef->descriptor;
            signatureLocation += sizeof(unsigned long int);
            signatureLocation += sizeof(unsigned long int);

            if (_flags & CTBlockDescriptionFlagsHasCopyDispose) {
                signatureLocation += sizeof(void(*)(void *dst, void *src));
                signatureLocation += sizeof(void (*)(void *src));
            }

            const char *signature = (*(const char **)signatureLocation);
            _blockSignature = [NSMethodSignature signatureWithObjCTypes:signature];
        }
    }
    return self;
}

- (BOOL)isCompatibleForBlockSwizzlingWithMethodSignature:(NSMethodSignature *)methodSignature
{
    if (_blockSignature.numberOfArguments != methodSignature.numberOfArguments + 1) {
        return NO;
    }

    if (strcmp(_blockSignature.methodReturnType, methodSignature.methodReturnType) != 0) {
        return NO;
    }

    for (int i = 0; i < methodSignature.numberOfArguments; i++) {
        if (i == 1) {
            // SEL in method, IMP in block
            if (strcmp([methodSignature getArgumentTypeAtIndex:i], ":") != 0) {
                return NO;
            }

            if (strcmp([_blockSignature getArgumentTypeAtIndex:i + 1], "^?") != 0) {
                return NO;
            }
        } else {
            if (strcmp([methodSignature getArgumentTypeAtIndex:i], [_blockSignature getArgumentTypeAtIndex:i + 1]) != 0) {
                return NO;
            }
        }
    }

    return YES;
}

- (NSString *)description
{
    return [NSString stringWithFormat:@"%@: %@", [super description], _blockSignature.description];
}

@end
