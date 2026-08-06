// Headers generated with ktool v1.4.0
// https://github.com/cxnder/ktool | pip3 install k2l
// Platform: IOS | Minimum OS: 16.0.0 | SDK: 16.0.0


#ifndef TUHANDLE_H
#define TUHANDLE_H

@class NSDictionary, NSString;

#import <Foundation/Foundation.h>

@interface TUHandle : NSObject



@property (readonly, copy, nonatomic) NSDictionary *dictionaryRepresentation;
@property (nonatomic) BOOL hasSetISOCountryCode; // ivar: _hasSetISOCountryCode
@property (copy, nonatomic) NSString *isoCountryCode; // ivar: _isoCountryCode
@property (readonly, copy, nonatomic) NSString *normalizedValue; // ivar: _normalizedValue
@property (nonatomic) NSInteger type; // ivar: _type
@property (copy, nonatomic) NSString *value; // ivar: _value


+(BOOL)supportsSecureCoding;
+(NSInteger)handleTypeForCHHandle:(id)arg0 ;
+(id)handleForCHRecentCall:(id)arg0 ;
+(id)handleForCHRecentCall:(id)arg0 validHandlesOnly:(BOOL)arg1 ;
+(id)handleWithDestinationID:(id)arg0 ;
+(id)handleWithDictionaryRepresentation:(id)arg0 ;
+(id)handleWithPersonHandle:(id)arg0 ;
+(id)handlesForCHRecentCall:(id)arg0 ;
+(id)handlesForCHRecentCall:(id)arg0 validHandlesOnly:(BOOL)arg1 ;
+(id)normalizedEmailAddressHandleForValue:(id)arg0 ;
+(id)normalizedGenericHandleForValue:(id)arg0 ;
+(id)normalizedHandleWithDestinationID:(id)arg0 ;
+(id)normalizedPhoneNumberHandleForValue:(id)arg0 isoCountryCode:(id)arg1 ;
+(id)stringForType:(NSInteger)arg0 ;
-(BOOL)isCanonicallyEqualToHandle:(id)arg0 isoCountryCode:(id)arg1 ;
-(BOOL)isEqual:(id)arg0 ;
-(BOOL)isEqualToHandle:(id)arg0 ;
-(BOOL)isEquivalentToHandle:(id)arg0 ;
-(BOOL)isValidForISOCountryCode:(id)arg0 ;
-(NSUInteger)hash;
-(id)canonicalHandleForISOCountryCode:(id)arg0 ;
-(id)copyWithZone:(struct _NSZone *)arg0 ;
-(id)description;
-(id)init;
-(id)initWithCoder:(id)arg0 ;
-(id)initWithDestinationID:(id)arg0 ;
-(id)initWithHandle:(id)arg0 ;
-(id)initWithType:(NSInteger)arg0 value:(id)arg1 ;
-(id)initWithType:(NSInteger)arg0 value:(id)arg1 normalizedValue:(id)arg2 ;
-(id)personHandle;
-(void)encodeWithCoder:(id)arg0 ;


@end


#endif
