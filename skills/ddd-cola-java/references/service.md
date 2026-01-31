# Service and Executor Templates

## Service Interface

```java
// client/api/UserServiceI.java
public interface UserServiceI {
    Response addUser(UserAddCmd cmd);
    SingleResponse<UserCO> getUser(UserGetQry qry);
    MultiResponse<UserCO> listUsers(UserListQry qry);
    PageResponse<UserCO> pageUsers(UserPageQry qry);
}
```

## Command Executor

```java
// app/command/UserAddCmdExe.java
@Component
public class UserAddCmdExe {
    
    @Autowired
    private UserGateway userGateway;
    
    public Response execute(UserAddCmd cmd) {
        // 1. Parameter validation
        if (StringUtils.isEmpty(cmd.getUserCO().getEmail())) {
            return Response.buildFailure("PARAM_ERROR", "Email cannot be empty");
        }
        
        // 2. Business logic check
        if (userGateway.existsByEmail(cmd.getUserCO().getEmail())) {
            return Response.buildFailure("EMAIL_EXISTS", "Email already exists");
        }
        
        // 3. Create domain entity
        User user = new User();
        BeanUtils.copyProperties(cmd.getUserCO(), user);
        
        // 4. Call Gateway to persist
        userGateway.save(user);
        
        return Response.buildSuccess();
    }
}
```

## Query Executor

```java
// app/command/query/UserListQryExe.java
@Component
public class UserListQryExe {
    
    @Autowired
    private UserGateway userGateway;
    
    @Autowired
    private UserConvertor userConvertor;
    
    public MultiResponse<UserCO> execute(UserListQry qry) {
        List<User> users = userGateway.listByCondition(
            qry.getKeyword(), qry.getPageIndex(), qry.getPageSize()
        );
        
        List<UserCO> userCOs = users.stream()
            .map(userConvertor::toClientObject)
            .collect(Collectors.toList());
        
        return MultiResponse.of(userCOs);
    }
}
```

## Service Implementation

```java
// app/service/UserServiceImpl.java
@Service
@CatchAndLog  // COLA exception handling annotation
public class UserServiceImpl implements UserServiceI {
    
    @Resource
    private UserAddCmdExe userAddCmdExe;
    
    @Resource
    private UserListQryExe userListQryExe;
    
    @Override
    public Response addUser(UserAddCmd cmd) {
        return userAddCmdExe.execute(cmd);
    }
    
    @Override
    public MultiResponse<UserCO> listUsers(UserListQry qry) {
        return userListQryExe.execute(qry);
    }
}
```

## Maven Dependency

```xml
<dependency>
    <groupId>com.alibaba.cola</groupId>
    <artifactId>cola-component-catchlog-starter</artifactId>
</dependency>
```
