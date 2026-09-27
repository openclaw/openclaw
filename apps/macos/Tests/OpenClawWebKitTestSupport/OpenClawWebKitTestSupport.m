#import "OpenClawWebKitTestSupport.h"

#import <objc/runtime.h>

static NSHashTable<WKWebView *> *suppressedWebViews;

@interface OpenClawWebKitTestGuard : NSObject
@end

@implementation OpenClawWebKitTestGuard

// WebKit removes Screen Time KVO on the main thread during WKWebView dealloc,
// while ScreenTime delivers configuration on a private queue. Short-lived test
// web views hit this race and abort the process; product builds keep Screen Time.
+ (void)load {
    Method method = class_getInstanceMethod(
        [WKWebView class], NSSelectorFromString(@"_installScreenTimeWebpageControllerIfNeeded"));
    if (method == NULL) {
        return;
    }

    NSHashTable<WKWebView *> *webViews = [NSHashTable weakObjectsHashTable];
    suppressedWebViews = webViews;
    method_setImplementation(method, imp_implementationWithBlock(^(WKWebView *webView) {
        @synchronized (webViews) {
            [webViews addObject:webView];
        }
    }));
}

@end

BOOL OpenClawWebKitTestSupportDidSuppressScreenTime(WKWebView *webView) {
    @synchronized (suppressedWebViews) {
        return [suppressedWebViews containsObject:webView];
    }
}
