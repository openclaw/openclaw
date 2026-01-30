# Mobile Performance Reference

> Deep dive into React Native and Flutter performance optimization, 60fps animations, memory management, and battery considerations.
> **This file covers the #1 area where AI-generated code FAILS.**

---

## 1. The Mobile Performance Mindset

### Why Mobile Performance is Different

```
DESKTOP:                          MOBILE:
├── Unlimited power               ├── Battery matters
├── Abundant RAM                  ├── RAM is shared, limited
├── Stable network                ├── Network is unreliable
├── CPU always available          ├── CPU throttles when hot
└── User expects fast anyway      └── User expects INSTANT
```

### Performance Budget Concept

```
Every frame must complete in:
├── 60fps → 16.67ms per frame
├── 120fps (ProMotion) → 8.33ms per frame

If your code takes longer:
├── Frame drops → Janky scroll/animation
├── User perceives as "slow" or "broken"
└── They WILL uninstall your app
```

---

## 2. React Native Performance

### 🚫 The #1 AI Mistake: ScrollView for Lists

```javascript
// ❌ NEVER DO THIS - AI's favorite mistake
<ScrollView>
  {items.map(item => (
    <ItemComponent key={item.id} item={item} />
  ))}
</ScrollView>

// Why it's catastrophic:
// ├── Renders ALL items immediately (1000 items = 1000 renders)
// ├── Memory explodes
// ├── Initial render takes seconds
// └── Scroll becomes janky

// ✅ ALWAYS USE FlatList
<FlatList
  data={items}
  renderItem={renderItem}
  keyExtractor={item => item.id}
/>
```

### FlatList Optimization Checklist

```javascript
// ✅ CORRECT: All optimizations applied

// 1. Memoize the item component
const ListItem = React.memo(({ item }: { item: Item }) => {
  return (
    <Pressable style={styles.item}>
      <Text>{item.title}</Text>
    </Pressable>
  );
});

// 2. Memoize renderItem with useCallback
const renderItem = useCallback(
  ({ item }: { item: Item }) => <ListItem item={item} />,
  [] // Empty deps = never recreated
);

// 3. Stable keyExtractor (NEVER use index!)
const keyExtractor = useCallback((item: Item) => item.id, []);

// 4. Provide getItemLayout for fixed-height items
const getItemLayout = useCallback(
  (data: Item[] | null, index: number) => ({
    length: ITEM_HEIGHT, // Fixed height
    offset: ITEM_HEIGHT * index,
    index,
  }),
  []
);

// 5. Apply to FlatList
<FlatList
  data={items}
  renderItem={renderItem}
  keyExtractor={keyExtractor}
  getItemLayout={getItemLayout}
  // Performance props
  removeClippedSubviews={true} // Android: detach off-screen
  maxToRenderPerBatch={10} // Items per batch
  windowSize={5} // Render window (5 = 2 screens each side)
  initialNumToRender={10} // Initial items
  updateCellsBatchingPeriod={50} // Batching delay
/>
```

### Why Each Optimization Matters

| Optimization | What It Prevents | Impact |
|--------------|------------------|--------|
| `React.memo` | Re-render on parent change | 🔴 Critical |
| `useCallback renderItem` | New function every render | 🔴 Critical |
| Stable `keyExtractor` | Wrong item recycling | 🔴 Critical |
| `getItemLayout` | Async layout calculation | 🟡 High |
| `removeClippedSubviews` | Memory from off-screen | 🟡 High |
| `maxToRenderPerBatch` | Blocking main thread | 🟢 Medium |
| `windowSize` | Memory usage | 🟢 Medium |

### FlashList: The Better Option

```javascript
// Consider FlashList for better performance
import { FlashList } from "@shopify/flash-list";

<FlashList
  data={items}
  renderItem={renderItem}
  estimatedItemSize={ITEM_HEIGHT}
  keyExtractor={keyExtractor}
/>

// Benefits over FlatList:
// ├── Faster recycling
// ├── Better memory management
// ├── Simpler API
// └── Fewer optimization props needed
```

### Animation Performance

```javascript
// ❌ JS-driven animation (blocks JS thread)
Animated.timing(value, {
  toValue: 1,
  duration: 300,
  useNativeDriver: false, // BAD!
}).start();

// ✅ Native-driver animation (runs on UI thread)
Animated.timing(value, {
  toValue: 1,
  duration: 300,
  useNativeDriver: true, // GOOD!
}).start();

// Native driver supports ONLY:
// ├── transform (translate, scale, rotate)
// └── opacity
// 
// Does NOT support:
// ├── width, height
// ├── backgroundColor
// ├── borderRadius changes
// └── margin, padding
```

### Reanimated for Complex Animations

```javascript
// For animations native driver can't handle, use Reanimated 3

import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from 'react-native-reanimated';

const Component = () => {
  const offset = useSharedValue(0);

  const animatedStyles = useAnimatedStyle(() => ({
    transform: [{ translateX: withSpring(offset.value) }],
  }));

  return <Animated.View style={animatedStyles} />;
};

// Benefits:
// ├── Runs on UI thread (60fps guaranteed)
// ├── Can animate any property
// ├── Gesture-driven animations
// └── Worklets for complex logic
```

### Memory Leak Prevention

```javascript
// ❌ Memory leak: uncleared interval
useEffect(() => {
  const interval = setInterval(() => {
    fetchData();
  }, 5000);
  // Missing cleanup!
}, []);

// ✅ Proper cleanup
useEffect(() => {
  const interval = setInterval(() => {
    fetchData();
  }, 5000);
  
  return () => clearInterval(interval); // CLEANUP!
}, []);

// Common memory leak sources:
// ├── Timers (setInterval, setTimeout)
// ├── Event listeners
// ├── Subscriptions (WebSocket, PubSub)
// ├── Async operations that update state after unmount
// └── Image caching without limits
```

### React Native Performance Checklist

```markdown
## Before Every List
- [ ] Using FlatList or FlashList (NOT ScrollView)
- [ ] renderItem is useCallback memoized
- [ ] List items are React.memo wrapped
- [ ] keyExtractor uses stable ID (NOT index)
- [ ] getItemLayout provided (if fixed height)

## Before Every Animation
- [ ] useNativeDriver: true (if possible)
- [ ] Using Reanimated for complex animations
- [ ] Only animating transform/opacity
- [ ] Tested on low-end Android device

## Before Any Release
- [ ] console.log statements removed
- [ ] Cleanup functions in all useEffects
- [ ] No memory leaks (test with profiler)
- [ ] Tested in release build (not dev)
```

---

## 3. Flutter Performance

### 🚫 The #1 AI Mistake: setState Overuse

```dart
// ❌ WRONG: setState rebuilds ENTIRE widget tree
class BadCounter extends StatefulWidget {
  @override
  State<BadCounter> createState() => _BadCounterState();
}

class _BadCounterState extends State<BadCounter> {
  int _counter = 0;
  
  void _increment() {
    setState(() {
      _counter++; // This rebuilds EVERYTHING below!
    });
  }
  
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text('Counter: $_counter'),
        ExpensiveWidget(), // Rebuilds unnecessarily!
        AnotherExpensiveWidget(), // Rebuilds unnecessarily!
      ],
    );
  }
}
```

### The `const` Constructor Revolution

```dart
// ✅ CORRECT: const prevents rebuilds

class GoodCounter extends StatefulWidget {
  const GoodCounter({super.key}); // CONST constructor!
  
  @override
  State<GoodCounter> createState() => _GoodCounterState();
}

class _GoodCounterState extends State<GoodCounter> {
  int _counter = 0;
  
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Text('Counter: $_counter'),
        const ExpensiveWidget(), // Won't rebuild!
        const AnotherExpensiveWidget(), // Won't rebuild!
      ],
    );
  }
}

// RULE: Add `const` to EVERY widget that doesn't depend on state
```

### Targeted State Management

```dart
// ❌ setState rebuilds whole tree
setState(() => _value = newValue);

// ✅ ValueListenableBuilder: surgical rebuilds
class TargetedState extends StatelessWidget {
  final ValueNotifier<int> counter = ValueNotifier(0);
  
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Only this rebuilds when counter changes
        ValueListenableBuilder<int>(
          valueListenable: counter,
          builder: (context, value, child) => Text('$value'),
          child: const Icon(Icons.star), // Won't rebuild!
        ),
        const ExpensiveWidget(), // Never rebuilds
      ],
    );
  }
}
```

### Riverpod/Provider Best Practices

```dart
// ❌ WRONG: Reading entire provider in build
Widget build(BuildContext context) {
  final state = ref.watch(myProvider); // Rebuilds on ANY change
  return Text(state.name);
}

// ✅ CORRECT: Select only what you need
Widget build(BuildContext context) {
  final name = ref.watch(myProvider.select((s) => s.name));
  return Text(name); // Only rebuilds when name changes
}
```

### ListView Optimization

```dart
// ❌ WRONG: ListView without builder (renders all)
ListView(
  children: items.map((item) => ItemWidget(item)).toList(),
)

// ✅ CORRECT: ListView.builder (lazy rendering)
ListView.builder(
  itemCount: items.length,
  itemBuilder: (context, index) => ItemWidget(items[index]),
  // Additional optimizations:
  itemExtent: 56, // Fixed height = faster layout
  cacheExtent: 100, // Pre-render distance
)

// ✅ EVEN BETTER: ListView.separated for dividers
ListView.separated(
  itemCount: items.length,
  itemBuilder: (context, index) => ItemWidget(items[index]),
  separatorBuilder: (context, index) => const Divider(),
)
```

### Image Optimization

```dart
// ❌ WRONG: No caching, full resolution
Image.network(url)

// ✅ CORRECT: Cached with proper sizing
CachedNetworkImage(
  imageUrl: url,
  width: 100,
  height: 100,
  fit: BoxFit.cover,
  memCacheWidth: 200, // Cache at 2x for retina
  memCacheHeight: 200,
  placeholder: (context, url) => const Skeleton(),
  errorWidget: (context, url, error) => const Icon(Icons.error),
)
```

### Dispose Pattern

```dart
class MyWidget extends StatefulWidget {
  @override
  State<MyWidget> createState() => _MyWidgetState();
}

class _MyWidgetState extends State<MyWidget> {
  late final StreamSubscription _subscription;
  late final AnimationController _controller;
  late final TextEditingController _textController;
  
  @override
  void initState() {
    super.initState();
    _subscription = stream.listen((_) {});
    _controller = AnimationController(vsync: this);
    _textController = TextEditingController();
  }
  
  @override
  void dispose() {
    // ALWAYS dispose in reverse order of creation
    _textController.dispose();
    _controller.dispose();
    _subscription.cancel();
    super.dispose();
  }
  
  @override
  Widget build(BuildContext context) => Container();
}
```

### Flutter Performance Checklist

```markdown
## Before Every Widget
- [ ] const constructor added (if no runtime args)
- [ ] const keywords on static children
- [ ] Minimal setState scope
- [ ] Using selectors for provider watches

## Before Every List
- [ ] Using ListView.builder (NOT ListView with children)
- [ ] itemExtent provided (if fixed height)
- [ ] Image caching with size limits

## Before Any Animation
- [ ] Using Impeller (Flutter 3.16+)
- [ ] Avoiding Opacity widget (use FadeTransition)
- [ ] TickerProviderStateMixin for AnimationController

## Before Any Release
- [ ] All dispose() methods implemented
- [ ] No print() in production
- [ ] Tested in profile/release mode
- [ ] DevTools performance overlay checked
```

---

## 4. Animation Performance (Both Platforms)

### The 60fps Imperative

```
Human eye detects:
├── < 24 fps → "Slideshow" (broken)
├── 24-30 fps → "Choppy" (uncomfortable)
├── 30-45 fps → "Noticeably not smooth"
├── 45-60 fps → "Smooth" (acceptable)
├── 60 fps → "Buttery" (target)
└── 120 fps → "Premium" (ProMotion devices)

NEVER ship < 60fps animations.
```

### GPU vs CPU Animation

```
GPU-ACCELERATED (FAST):          CPU-BOUND (SLOW):
├── transform: translate          ├── width, height
├── transform: scale              ├── top, left, right, bottom
├── transform: rotate             ├── margin, padding
├── opacity                       ├── border-radius (animated)
└── (Composited, off main)        └── box-shadow (animated)

RULE: Only animate transform and opacity.
Everything else causes layout recalculation.
```

### Animation Timing Guide

| Animation Type | Duration | Easing |
|----------------|----------|--------|
| Micro-interaction | 100-200ms | ease-out |
| Standard transition | 200-300ms | ease-out |
| Page transition | 300-400ms | ease-in-out |
| Complex/dramatic | 400-600ms | ease-in-out |
| Loading skeletons | 1000-1500ms | linear (loop) |

### Spring Physics

```javascript
// React Native Reanimated
withSpring(targetValue, {
  damping: 15,      // How quickly it settles (higher = faster stop)
  stiffness: 150,   // How "tight" the spring (higher = faster)
  mass: 1,          // Weight of the object
})

// Flutter
SpringSimulation(
  SpringDescription(
    mass: 1,
    stiffness: 150,
    damping: 15,
  ),
  start,
  end,
  velocity,
)

// Natural feel ranges:
// Damping: 10-20 (bouncy to settled)
// Stiffness: 100-200 (loose to tight)
// Mass: 0.5-2 (light to heavy)
```

---

## 5. Memory Management

### Common Memory Leaks

| Source | Platform | Solution |
|--------|----------|----------|
| Timers | Both | Clear in cleanup/dispose |
| Event listeners | Both | Remove in cleanup/dispose |
| Subscriptions | Both | Cancel in cleanup/dispose |
| Large images | Both | Limit cache, resize |
| Async after unmount | RN | isMounted check or AbortController |
| Animation controllers | Flutter | Dispose controllers |

### Image Memory

```
Image memory = width × height × 4 bytes (RGBA)

1080p image = 1920 × 1080 × 4 = 8.3 MB
4K image = 3840 × 2160 × 4 = 33.2 MB

10 4K images = 332 MB → App crash!

RULE: Always resize images to display size (or 2-3x for retina).
```

### Memory Profiling

```
React Native:
├── Flipper → Memory tab
├── Xcode Instruments (iOS)
└── Android Studio Profiler

Flutter:
├── DevTools → Memory tab
├── Observatory
└── flutter run --profile
```

---

## 6. Battery Optimization

### Battery Drain Sources

| Source | Impact | Mitigation |
|--------|--------|------------|
| **Screen on** | 🔴 Highest | Dark mode on OLED |
| **GPS continuous** | 🔴 Very high | Use significant change |
| **Network requests** | 🟡 High | Batch, cache aggressively |
| **Animations** | 🟡 Medium | Reduce when low battery |
| **Background work** | 🟡 Medium | Defer non-critical |
| **CPU computation** | 🟢 Lower | Offload to backend |

### OLED Battery Saving

```
OLED screens: Black pixels = OFF = 0 power

Dark mode savings:
├── True black (#000000) → Maximum savings
├── Dark gray (#1a1a1a) → Slight savings
├── Any color → Some power
└── White (#FFFFFF) → Maximum power

RULE: On dark mode, use true black for backgrounds.
```

### Background Task Guidelines

```
iOS:
├── Background refresh: Limited, system-scheduled
├── Push notifications: Use for important updates
├── Background modes: Location, audio, VoIP only
└── Background tasks: Max ~30 seconds

Android:
├── WorkManager: System-scheduled, battery-aware
├── Foreground service: Visible to user, continuous
├── JobScheduler: Batch network operations
└── Doze mode: Respect it, batch operations
```

---

## 7. Network Performance

### Offline-First Architecture

```
                    ┌──────────────┐
                    │     UI       │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Cache      │ ← Read from cache FIRST
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Network    │ ← Update cache from network
                    └──────────────┘

Benefits:
├── Instant UI (no loading spinner for cached data)
├── Works offline
├── Reduces data usage
└── Better UX on slow networks
```

### Request Optimization

```
BATCH: Combine multiple requests into one
├── 10 small requests → 1 batch request
├── Reduces connection overhead
└── Better for battery (radio on once)

CACHE: Don't re-fetch unchanged data
├── ETag/If-None-Match headers
├── Cache-Control headers
└── Stale-while-revalidate pattern

COMPRESS: Reduce payload size
├── gzip/brotli compression
├── Request only needed fields (GraphQL)
└── Paginate large lists
```

---

## 8. Performance Testing

### What to Test

| Metric | Target | Tool |
|--------|--------|------|
| **Frame rate** | ≥ 60fps | Performance overlay |
| **Memory** | Stable, no growth | Profiler |
| **Cold start** | < 2s | Manual timing |
| **TTI (Time to Interactive)** | < 3s | Lighthouse |
| **List scroll** | No jank | Manual feel |
| **Animation smoothness** | No drops | Performance monitor |

### Test on Real Devices

```
⚠️ NEVER trust only:
├── Simulator/emulator (faster than real)
├── Dev mode (slower than release)
├── High-end devices only

✅ ALWAYS test on:
├── Low-end Android (< $200 phone)
├── Older iOS device (iPhone 8 or SE)
├── Release/profile build
└── With real data (not 10 items)
```

### Performance Monitoring Checklist

```markdown
## During Development
- [ ] Performance overlay enabled
- [ ] Watching for dropped frames
- [ ] Memory usage stable
- [ ] No console warnings about performance

## Before Release
- [ ] Tested on low-end device
- [ ] Profiled memory over extended use
- [ ] Cold start time measured
- [ ] List scroll tested with 1000+ items
- [ ] Animations tested at 60fps
- [ ] Network tested on slow 3G
```

---

## 9. Quick Reference Card

### React Native Essentials

```javascript
// List: Always use
<FlatList
  data={data}
  renderItem={useCallback(({item}) => <MemoItem item={item} />, [])}
  keyExtractor={useCallback(item => item.id, [])}
  getItemLayout={useCallback((_, i) => ({length: H, offset: H*i, index: i}), [])}
/>

// Animation: Always native
useNativeDriver: true

// Cleanup: Always present
useEffect(() => {
  return () => cleanup();
}, []);
```

### Flutter Essentials

```dart
// Widgets: Always const
const MyWidget()

// Lists: Always builder
ListView.builder(itemBuilder: ...)

// State: Always targeted
ValueListenableBuilder() or ref.watch(provider.select(...))

// Dispose: Always cleanup
@override
void dispose() {
  controller.dispose();
  super.dispose();
}
```

### Animation Targets

```
Transform/Opacity only ← What to animate
16.67ms per frame ← Time budget
60fps minimum ← Target
Low-end Android ← Test device
```

---

> **Remember:** Performance is not optimization—it's baseline quality. A slow app is a broken app. Test on the worst device your users have, not the best device you have.
