// Intercept only the Objective-C OS boundary, preserving the legacy callback ABI.
#import "OpenClawWebKitTestSupport.h"
#import <Speech/Speech.h>
#import <objc/runtime.h>
#import <stdatomic.h>

static IMP originalStatus;
static IMP originalRequest;
static IMP fixtureStatus;
static IMP fixtureRequest;
static atomic_int requests;
static atomic_int authorization;

BOOL OpenClawInstallSpeechAuthorizationFixture(void) {
    Method status = class_getClassMethod([SFSpeechRecognizer class], @selector(authorizationStatus));
    Method request = class_getClassMethod([SFSpeechRecognizer class], @selector(requestAuthorization:));
    if (!status || !request || originalStatus || originalRequest) return NO;
    atomic_store(&requests, 0);
    atomic_store(&authorization, SFSpeechRecognizerAuthorizationStatusNotDetermined);
    fixtureStatus = imp_implementationWithBlock(^SFSpeechRecognizerAuthorizationStatus(id receiver) {
        return (SFSpeechRecognizerAuthorizationStatus)atomic_load(&authorization);
    });
    fixtureRequest = imp_implementationWithBlock(^(id receiver, void (^completion)(SFSpeechRecognizerAuthorizationStatus)) {
        atomic_fetch_add(&requests, 1);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
            atomic_store(&authorization, SFSpeechRecognizerAuthorizationStatusAuthorized);
            NSCAssert(![NSThread isMainThread], @"Speech fixture must invoke completion off main");
            completion(SFSpeechRecognizerAuthorizationStatusAuthorized);
        });
    });
    originalStatus = method_setImplementation(status, fixtureStatus);
    originalRequest = method_setImplementation(request, fixtureRequest);
    return YES;
}

int OpenClawSpeechAuthorizationRequestCount(void) { return atomic_load(&requests); }

void OpenClawRestoreSpeechAuthorizationFixture(void) {
    if (!originalStatus || !originalRequest) return;
    method_setImplementation(class_getClassMethod([SFSpeechRecognizer class], @selector(authorizationStatus)), originalStatus);
    method_setImplementation(class_getClassMethod([SFSpeechRecognizer class], @selector(requestAuthorization:)), originalRequest);
    imp_removeBlock(fixtureStatus);
    imp_removeBlock(fixtureRequest);
    originalStatus = NULL;
    originalRequest = NULL;
}
