export class WebRTCStreamHandler {
  private audioTrack: any;
  private listeners: any = {};

  emit(event: string, payload?: any) {
    if (this.listeners[event]) {
      this.listeners[event].forEach((cb: any) => cb(payload));
    }
  }

  emitTranscriptEvent(text: string, itemId: string, responseId: string) {
    this.emit('transcript', {
      text: text,
      timestamp: Date.now(),
      itemId,
      responseId
    });
  }

  cleanupStream() {
    if (this.audioTrack) {
      this.audioTrack.stop();
    }
    this.emit('stream.closed');
    this.emit('turn.ended', { 
      reason: 'stream_cleanup',
      timestamp: Date.now() 
    });
  }
}