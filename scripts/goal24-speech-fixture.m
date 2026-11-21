// Hosted proof overlay only. Intercept OS I/O, not the production Swift call.
#import <Speech/Speech.h>
#import <objc/runtime.h>
#import <stdatomic.h>
#import <stdio.h>
#import <execinfo.h>
#import <signal.h>
#import <unistd.h>

static IMP originalStatus;
static IMP originalRequest;
static IMP fixtureStatus;
static IMP fixtureRequest;
static atomic_int requests;
static atomic_int authorization;
static struct sigaction previousTrap;

// The hosted Swift crash helper cannot symbolize privileged test executables.
// Preserve the crashing thread before exiting; never synthesize a signal.
static void Goal24PrintNativeTrap(int signal) {
    (void)signal;
    const char marker[] = "Signal 5: Goal24 native crashing-thread trace\n";
    write(STDERR_FILENO, marker, sizeof(marker) - 1);
    void *frames[64];
    int count = backtrace(frames, 64);
    backtrace_symbols_fd(frames, count, STDERR_FILENO);
    _exit(128 + SIGTRAP);
}

BOOL Goal24InstallSpeechFixture(void) {
    Method status = class_getClassMethod([SFSpeechRecognizer class], @selector(authorizationStatus));
    Method request = class_getClassMethod([SFSpeechRecognizer class], @selector(requestAuthorization:));
    if (!status || !request || originalStatus || originalRequest) return NO;
    struct sigaction trap = {0};
    trap.sa_handler = Goal24PrintNativeTrap;
    sigemptyset(&trap.sa_mask);
    if (sigaction(SIGTRAP, &trap, &previousTrap) != 0) return NO;
    atomic_store(&requests, 0);
    atomic_store(&authorization, SFSpeechRecognizerAuthorizationStatusNotDetermined);
    fixtureStatus = imp_implementationWithBlock(^SFSpeechRecognizerAuthorizationStatus(id receiver) {
        return (SFSpeechRecognizerAuthorizationStatus)atomic_load(&authorization);
    });
    fixtureRequest = imp_implementationWithBlock(^(id receiver, void (^completion)(SFSpeechRecognizerAuthorizationStatus)) {
        atomic_fetch_add(&requests, 1);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
            atomic_store(&authorization, SFSpeechRecognizerAuthorizationStatusAuthorized);
            fprintf(stderr, "GOAL24_SPEECH_CALLBACK background=%d requests=%d\n", ![NSThread isMainThread], atomic_load(&requests));
            fflush(stderr);
            completion(SFSpeechRecognizerAuthorizationStatusAuthorized);
        });
    });
    originalStatus = method_setImplementation(status, fixtureStatus);
    originalRequest = method_setImplementation(request, fixtureRequest);
    return YES;
}

int Goal24SpeechRequestCount(void) { return atomic_load(&requests); }

void Goal24RestoreSpeechFixture(void) {
    if (!originalStatus || !originalRequest) return;
    method_setImplementation(class_getClassMethod([SFSpeechRecognizer class], @selector(authorizationStatus)), originalStatus);
    method_setImplementation(class_getClassMethod([SFSpeechRecognizer class], @selector(requestAuthorization:)), originalRequest);
    imp_removeBlock(fixtureStatus);
    imp_removeBlock(fixtureRequest);
    sigaction(SIGTRAP, &previousTrap, NULL);
    originalStatus = NULL;
    originalRequest = NULL;
}
