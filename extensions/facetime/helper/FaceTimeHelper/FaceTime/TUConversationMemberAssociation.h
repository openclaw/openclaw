// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUCONVERSATIONMEMBERASSOCIATION_H
#define TUCONVERSATIONMEMBERASSOCIATION_H

@class NSString;

#import <Foundation/Foundation.h>

#import "TUHandle.h"

@interface TUConversationMemberAssociation : NSObject



@property (copy, nonatomic) NSString *avcIdentifier; // ivar: _avcIdentifier
@property (retain, nonatomic) TUHandle *handle; // ivar: _handle
@property (nonatomic) NSUInteger identifier; // ivar: _identifier
@property (nonatomic, getter=isPrimary) BOOL primary; // ivar: _primary
@property (nonatomic) NSInteger type; // ivar: _type


+(BOOL)supportsSecureCoding;
-(BOOL)isEqual:(id)arg0 ;
-(BOOL)isEqualToAssociation:(id)arg0 ;
-(NSUInteger)hash;
-(id)copyWithZone:(struct _NSZone *)arg0 ;
-(id)description;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithHandle:(id)arg0 type:(NSInteger)arg1 primary:(BOOL)arg2 ;
-(id)initWithMemberAssociation:(id)arg0 ;
-(void)encodeWithCoder:(id)arg0 ;


@end


#endif
