# Gateway Pattern Templates

## Gateway Interface

```java
// domain/gateway/UserGateway.java
public interface UserGateway {
    void save(User user);
    User getById(Long userId);
    boolean existsByEmail(String email);
    List<User> listByCondition(String keyword, int page, int size);
}
```

## Gateway Implementation

```java
// infrastructure/gatewayimpl/UserGatewayImpl.java
@Component
public class UserGatewayImpl implements UserGateway {
    
    @Autowired
    private UserMapper userMapper;
    
    @Autowired
    private UserConvertor userConvertor;
    
    @Override
    public void save(User user) {
        UserDO userDO = userConvertor.toDataObject(user);
        if (userDO.getId() == null) {
            userMapper.insert(userDO);
        } else {
            userMapper.updateById(userDO);
        }
    }
    
    @Override
    public User getById(Long userId) {
        UserDO userDO = userMapper.selectById(userId);
        return userConvertor.toDomain(userDO);
    }
    
    @Override
    public boolean existsByEmail(String email) {
        return userMapper.countByEmail(email) > 0;
    }
    
    @Override
    public List<User> listByCondition(String keyword, int page, int size) {
        List<UserDO> userDOs = userMapper.selectByCondition(keyword, (page - 1) * size, size);
        return userDOs.stream()
            .map(userConvertor::toDomain)
            .collect(Collectors.toList());
    }
}
```

## Convertor

```java
// infrastructure/convertor/UserConvertor.java
@Component
public class UserConvertor {
    
    public UserDO toDataObject(User user) {
        if (user == null) return null;
        UserDO userDO = new UserDO();
        BeanUtils.copyProperties(user, userDO);
        return userDO;
    }
    
    public User toDomain(UserDO userDO) {
        if (userDO == null) return null;
        User user = new User();
        BeanUtils.copyProperties(userDO, user);
        return user;
    }
    
    public UserCO toClientObject(User user) {
        if (user == null) return null;
        UserCO userCO = new UserCO();
        BeanUtils.copyProperties(user, userCO);
        return userCO;
    }
}
```

## Domain Entity

```java
// domain/user/User.java
@Data
public class User {
    private Long id;
    private String name;
    private String email;
    private UserStatus status;
    
    // Domain behavior
    public void activate() {
        if (this.status == UserStatus.INACTIVE) {
            this.status = UserStatus.ACTIVE;
        }
    }
    
    public void deactivate() {
        this.status = UserStatus.INACTIVE;
    }
    
    public boolean isActive() {
        return this.status == UserStatus.ACTIVE;
    }
}
```

## Data Object

```java
// infrastructure/dataobject/UserDO.java
@Data
@TableName("users")
public class UserDO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String name;
    private String email;
    private String status;
}
```
