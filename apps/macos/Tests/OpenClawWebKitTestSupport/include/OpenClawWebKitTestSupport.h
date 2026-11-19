#ifndef OPENCLAW_WEBKIT_TEST_SUPPORT_H
#define OPENCLAW_WEBKIT_TEST_SUPPORT_H

#import <WebKit/WebKit.h>

BOOL OpenClawWebKitTestSupportDidSuppressScreenTime(WKWebView * _Nonnull webView);

// Install only while the serialized permission boundary test owns the fixture.
BOOL OpenClawInstallSpeechAuthorizationFixture(void);
int OpenClawSpeechAuthorizationRequestCount(void);
void OpenClawRestoreSpeechAuthorizationFixture(void);

#endif
